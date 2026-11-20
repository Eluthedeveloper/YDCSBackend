import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ queryAll: vi.fn(), runSQL: vi.fn(), queryOne: vi.fn() }));
const cache = vi.hoisted(() => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../database/schema', () => db);
vi.mock('../cache/redis', () => ({ ...cache, rateLimitRedis: null, default: null }));

const { detectLanguage, EVENTS_SUMMARY_ID, LATEST_TRACKS_SUMMARY_ID, mapWritePathToSource, syncContentSource, WHATS_NEW_SUMMARY_ID } = await import('./chatbotSync');

beforeEach(() => {
  db.queryAll.mockReset();
  db.runSQL.mockReset();
  db.queryOne.mockReset();
  cache.cacheDelete.mockClear();
  db.queryAll.mockResolvedValue([]);
  db.runSQL.mockResolvedValue(undefined);
  db.queryOne.mockResolvedValue(null);
});

describe('chatbot content sync', () => {
  it('detects Amharic, Oromo and English content', () => {
    expect(detectLanguage('የዜና ገጽ')).toBe('am');
    expect(detectLanguage('Sagantaa haaraa')).toBe('om');
    expect(detectLanguage('Latest programme update')).toBe('en');
  });

  it('maps successful content writes to sync sources', () => {
    expect(mapWritePathToSource('POST', '/api/site/announcements')).toEqual({
      table: 'announcements', id: undefined,
    });
    expect(mapWritePathToSource('PUT', '/api/site/blog/article-1')).toEqual({
      table: 'blog_posts', id: 'article-1',
    });
    expect(mapWritePathToSource('GET', '/api/site/blog')).toBeNull();
    expect(mapWritePathToSource('POST', '/api/auth/login')).toBeNull();
  });

  it('turns published content into searchable knowledge and clears the cache', async () => {
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      if (sql.includes('FROM blog_posts')) {
        return Promise.resolve([{
          id: 'post-1', slug: 'good-news', title: 'Good News', excerpt: 'Encouraging teaching',
          body: 'A short article about hope.', created_at: '2026-01-01 00:00:00',
          updated_at: '2026-01-02 00:00:00',
        }]);
      }
      return Promise.resolve([]);
    });

    const count = await syncContentSource('blog_posts');

    expect(count).toBe(2);
    expect(db.runSQL).toHaveBeenCalledTimes(4);
    const [knowledgeSql, knowledgeParams] = db.runSQL.mock.calls[0] as [string, unknown[]];
    expect(knowledgeSql).toContain('INSERT INTO chatbot_knowledge');
    expect((knowledgeSql.match(/\?/g) ?? []).length).toBe(knowledgeParams.length);
    expect(knowledgeParams[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    expect(String(knowledgeParams[0]).length).toBe(36);
    expect(knowledgeParams).toContain('approved');
    expect(String(db.runSQL.mock.calls[1][0])).toContain('INSERT INTO chatbot_content_sources');
    for (const call of db.runSQL.mock.calls) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    }
    expect(cache.cacheDelete).toHaveBeenCalled();

    await syncContentSource('blog_posts');
    expect((db.runSQL.mock.calls[4][1] as unknown[])[0]).toBe(knowledgeParams[0]);
  });

  it('creates a database-backed latest-tracks summary', async () => {
    const latest = [
      { id: 'track-1', title: 'Morning Praise', artist: 'Choir', program_id: 'prog-1', created_at: '2026-03-02 00:00:00' },
      { id: 'track-2', title: 'Evening Worship', artist: 'Team', program_id: 'prog-2', created_at: '2026-03-01 00:00:00' },
    ];
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      if (sql.includes('ORDER BY created_at DESC LIMIT 5')) return Promise.resolve(latest);
      if (sql.includes('FROM tracks')) return Promise.resolve(latest);
      return Promise.resolve([]);
    });

    expect(await syncContentSource('tracks')).toBe(3);

    const summary = db.runSQL.mock.calls.find((call) => call[1]?.[0] === LATEST_TRACKS_SUMMARY_ID);
    expect(summary).toBeDefined();
    const [summarySql, summaryParams] = summary as [string, unknown[]];
    expect(summarySql).toContain('INSERT INTO chatbot_knowledge');
    expect(String(summaryParams[5])).toContain('Morning Praise');
    expect(String(summaryParams[5])).toContain('Evening Worship');
    expect(String(summaryParams[5])).toContain('/programs/latest');
    for (const call of db.runSQL.mock.calls) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    }
  });

  it('creates a database-backed upcoming-events summary', async () => {
    const events = [
      { id: 'event-1', title: 'Gospel Conference', description: 'A time of worship and teaching', location: 'Addis Ababa', starts_at: '2026-12-01 09:00:00', created_at: '2026-02-01 00:00:00' },
      { id: 'event-2', title: 'Youth Fellowship', description: 'Weekly gathering', location: 'Bole', starts_at: '2026-12-08 10:00:00', created_at: '2026-02-02 00:00:00' },
    ];
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      if (sql.includes('FROM events')) return Promise.resolve(events);
      return Promise.resolve([]);
    });

    expect(await syncContentSource('events')).toBe(4);

    const summary = db.runSQL.mock.calls.find((call) => call[1]?.[0] === EVENTS_SUMMARY_ID);
    expect(summary).toBeDefined();
    const [summarySql, summaryParams] = summary as [string, unknown[]];
    expect(summarySql).toContain('INSERT INTO chatbot_knowledge');
    expect(String(summaryParams[5])).toContain('Gospel Conference');
    expect(String(summaryParams[5])).toContain('2026-12-01 09:00');
    expect(String(summaryParams[5])).toContain('Addis Ababa');
    expect(String(summaryParams[3])).toContain('tell me events');
    for (const call of db.runSQL.mock.calls) {
      const sql = String(call[0]);
      const params = call[1] as unknown[];
      expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    }
  });

  it('creates an empty-events summary when no events are scheduled', async () => {
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    expect(await syncContentSource('events')).toBe(2);

    const summary = db.runSQL.mock.calls.find((call) => call[1]?.[0] === EVENTS_SUMMARY_ID);
    expect(summary).toBeDefined();
    expect(String((summary as [string, unknown[]])[1][5])).toContain('no events posted');
  });

  it('creates a what-is-new summary from database content', async () => {
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      if (sql.includes('FROM blog_posts')) return Promise.resolve([{
        id: 'post-1', slug: 'hope', title: 'A Word of Hope', excerpt: 'Encouragement', created_at: '2026-11-17 00:00:00',
      }]);
      if (sql.includes('FROM announcements')) return Promise.resolve([{
        id: 'ann-1', title: 'New Announcement', body: 'Something important', created_at: '2026-11-18 00:00:00',
      }]);
      if (sql.includes('FROM events')) return Promise.resolve([{
        id: 'event-1', title: 'New Event', description: 'Join us', location: 'Addis Ababa',
        starts_at: '2026-12-01 09:00:00', created_at: '2026-11-19 00:00:00',
      }]);
      return Promise.resolve([]);
    });

    expect(await syncContentSource('events')).toBe(3);

    const summary = db.runSQL.mock.calls.find((call) => call[1]?.[0] === WHATS_NEW_SUMMARY_ID);
    expect(summary).toBeDefined();
    const [summarySql, summaryParams] = summary as [string, unknown[]];
    expect(summarySql).toContain('INSERT INTO chatbot_knowledge');
    expect(String(summaryParams[5])).toContain("What's new on the website");
    expect(String(summaryParams[5])).toContain('[Event] New Event');
    expect(String(summaryParams[5])).toContain('[Announcement] New Announcement');
    expect(String(summaryParams[5])).toContain('[Blog] A Word of Hope');
    expect(String(summaryParams[5]).indexOf('New Event')).toBeLessThan(String(summaryParams[5]).indexOf('New Announcement'));
    expect(String(summaryParams[3])).toContain("what's new");
  });

  it('does not sync unpublished-only sources when no rows are returned', async () => {
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    expect(await syncContentSource('albums')).toBe(0);
    expect(db.runSQL).not.toHaveBeenCalled();
  });
});
