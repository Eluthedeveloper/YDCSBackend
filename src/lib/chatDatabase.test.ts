import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * These tests pin the database boundary: a tool may search public content but
 * must never reach account, comment, like or listen data, and a marker left in
 * a row must not leak through the response mapping.
 */

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../database/schema', () => ({
  queryAll: db.queryAll,
  queryOne: db.queryOne,
}));

import { CHAT_TOOL_DECLARATIONS, executeChatTool } from './chatDatabase';

beforeEach(() => {
  db.queryAll.mockReset();
  db.queryOne.mockReset();
  db.queryAll.mockResolvedValue([]);
  db.queryOne.mockResolvedValue(undefined);
});

describe('chat database tools', () => {
  it('declares only public-content tools', () => {
    const names = CHAT_TOOL_DECLARATIONS.map((tool) => tool.name).join(' ');
    expect(names).not.toMatch(/user|password|email|comment|like|listen/i);
    expect(names).toContain('search_programs');
    expect(names).toContain('search_blog_posts');
  });

  it('escapes LIKE wildcards and never returns private columns', async () => {
    db.queryAll.mockResolvedValue([{
      id: 'p1',
      title: '100% Prayer',
      description: 'A 100% prayer show.',
      track_count: 2,
      created_at: new Date('2026-01-01T00:00:00Z'),
      created_by: 'private-user-id',
      file_path: '/private/audio.mp3',
      email: 'private@example.com',
    }]);

    const result = await executeChatTool({
      name: 'search_programs',
      args: { query: '100%_' },
    });

    expect(db.queryAll).toHaveBeenCalledTimes(1);
    const [sql, params] = db.queryAll.mock.calls[0];
    expect(sql).toContain('FROM programs');
    expect(sql).toContain('ESCAPE');
    expect(params).toEqual(['%100!%!_%', '%100!%!_%']);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('private-user-id');
    expect(serialised).not.toContain('/private/audio.mp3');
    expect(serialised).not.toContain('private@example.com');
    expect(serialised).toContain('100% Prayer');
  });

  it('searches only published blog articles', async () => {
    await executeChatTool({ name: 'search_blog_posts', args: { query: 'radio' } });

    const [sql, params] = db.queryAll.mock.calls[0];
    expect(sql).toContain('FROM blog_posts');
    expect(sql).toContain('published = 1');
    expect(sql).not.toContain(' users ');
    expect(params).toEqual(['%radio%', '%radio%', '%radio%', '%radio%']);
  });

  it('defaults event lookups to upcoming and supports past and all', async () => {
    await executeChatTool({ name: 'list_events' });
    expect(String(db.queryAll.mock.calls[0][0])).toContain('starts_at >= NOW()');

    await executeChatTool({ name: 'list_events', args: { scope: 'past' } });
    expect(String(db.queryAll.mock.calls[1][0])).toContain('starts_at < NOW()');

    await executeChatTool({ name: 'list_events', args: { scope: 'all' } });
    const allSql = String(db.queryAll.mock.calls[2][0]);
    expect(allSql).toContain('ORDER BY starts_at DESC');
    expect(allSql).not.toContain('NOW()');
  });

  it('rejects unknown tools without touching the database', async () => {
    const result = await executeChatTool({ name: 'select_from_users' });

    expect(result).toEqual({ error: expect.stringContaining('not available') });
    expect(db.queryAll).not.toHaveBeenCalled();
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it('turns a driver failure into a generic error', async () => {
    db.queryAll.mockRejectedValue(new Error('Table users is broken'));

    const result = await executeChatTool({
      name: 'search_programs',
      args: { query: 'prayer' },
    });

    expect(result).toEqual({ error: expect.stringContaining('could not be loaded') });
    expect(JSON.stringify(result)).not.toContain('users');
  });

  it('returns public content counts', async () => {
    db.queryOne.mockResolvedValue({
      programs: '2',
      tracks: '5',
      published_articles: '1',
      announcements: '0',
      upcoming_events: '3',
      leaders: '4',
      albums: '2',
      photos: '9',
    });

    const result = await executeChatTool({ name: 'get_content_stats' });

    expect(result).toEqual({
      output: {
        counts: {
          programs: 2,
          tracks: 5,
          published_articles: 1,
          announcements: 0,
          upcoming_events: 3,
          leaders: 4,
          albums: 2,
          photos: 9,
        },
      },
    });
  });
});
