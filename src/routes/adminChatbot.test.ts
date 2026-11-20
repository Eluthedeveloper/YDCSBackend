import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
}));
const chat = vi.hoisted(() => ({
  invalidateChatbotCache: vi.fn().mockResolvedValue(undefined),
  isLang: (value: unknown): boolean => ['en', 'am', 'om'].includes(String(value)),
  loadSettings: vi.fn().mockResolvedValue({
    confidenceThreshold: 0.38,
    fuzzyThreshold: 0.42,
    welcomeMessages: { en: 'Hi', am: 'ሰላም', om: 'Akkam' },
    fallbackMessages: { en: 'No answer', am: 'አልተገኘም', om: 'Hin argamne' },
    enabledLanguages: ['en', 'am', 'om'],
    autoApproveContent: true,
    syncIntervalMinutes: 10,
    maxHistoryTurns: 12,
  }),
  SETTINGS_CACHE_KEY: 'chatbot:settings',
}));
const sync = vi.hoisted(() => ({
  getSyncStatus: vi.fn().mockResolvedValue([]),
  syncAllContent: vi.fn().mockResolvedValue(3),
  syncContentSource: vi.fn().mockResolvedValue(1),
  SYNCED_TABLES: ['announcements', 'events', 'blog_posts', 'programs', 'tracks', 'albums', 'leaders', 'radio_schedule'],
}));
const auth = vi.hoisted(() => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin-1', role: 'admin' };
    next();
  },
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../database/schema', () => ({
  queryAll: db.queryAll,
  queryOne: db.queryOne,
  runSQL: db.runSQL,
}));
vi.mock('../cache/redis', () => ({
  ...cache,
  cacheGet: vi.fn().mockResolvedValue(null),
  rateLimitRedis: null,
  default: null,
}));
vi.mock('../lib/chatbot', () => chat);
vi.mock('../lib/chatbotSync', () => sync);
vi.mock('../middleware/auth', () => auth);

const { default: adminChatbotRoutes } = await import('./adminChatbot');

const app = express();
app.use(express.json());
app.use('/api/admin/chatbot', adminChatbotRoutes);

beforeEach(() => {
  db.queryAll.mockReset();
  db.queryOne.mockReset();
  db.runSQL.mockReset();
  cache.cacheSet.mockClear();
  chat.invalidateChatbotCache.mockClear();
  sync.syncAllContent.mockClear();
  sync.syncContentSource.mockClear();
  db.queryAll.mockResolvedValue([]);
  db.queryOne.mockResolvedValue(null);
  db.runSQL.mockResolvedValue(undefined);
});

describe('admin chatbot routes', () => {
  it('lists knowledge entries', async () => {
    db.queryAll.mockResolvedValue([{
      id: 'kb-1', intent_id: null, intent_name: null, language: 'en', question: 'Question?',
      alternative_questions: '[]', keywords: '[]', answer: 'Answer', priority: 0, is_active: 1,
      source_type: 'manual', source_url: null, sync_status: 'approved', updated_at: '2026-01-01 00:00:00',
    }]);

    const res = await request(app).get('/api/admin/chatbot/knowledge');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].question).toBe('Question?');
  });

  it('creates a knowledge entry and invalidates the cache', async () => {
    const res = await request(app)
      .post('/api/admin/chatbot/knowledge')
      .send({
        language: 'en', question: 'Where are the bookshops?', answer: 'In Addis Ababa.',
        alternative_questions: ['Where can I buy books?'], keywords: ['bookshop', 'books'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(db.runSQL).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chatbot_knowledge'),
      expect.arrayContaining(['Where are the bookshops?', 'In Addis Ababa.'])
    );
    expect(chat.invalidateChatbotCache).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid knowledge entry', async () => {
    const res = await request(app)
      .post('/api/admin/chatbot/knowledge')
      .send({ language: 'en', answer: 'Answer' });
    expect(res.status).toBe(400);
  });

  it('returns analytics and unanswered counts', async () => {
    db.queryOne.mockResolvedValue({ conversations: 4, questions: 10, answered: 8, unanswered: 2 });
    const res = await request(app).get('/api/admin/chatbot/analytics');

    expect(res.status).toBe(200);
    expect(res.body.totals.successRate).toBe(80);
    expect(res.body.totals.unanswered).toBe(2);
  });

  it('updates settings with validated values', async () => {
    const res = await request(app)
      .put('/api/admin/chatbot/settings')
      .send({ confidence_threshold: 0.6, enabled_languages: ['en', 'am'] });

    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chatbot_settings'),
      expect.arrayContaining(['confidence_threshold', '0.6'])
    );
    expect(chat.invalidateChatbotCache).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid threshold', async () => {
    const res = await request(app)
      .put('/api/admin/chatbot/settings')
      .send({ confidence_threshold: 2 });
    expect(res.status).toBe(400);
  });

  it('runs a full content sync', async () => {
    const res = await request(app).post('/api/admin/chatbot/sync/run').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 3 });
    expect(sync.syncAllContent).toHaveBeenCalledTimes(1);
  });
});
