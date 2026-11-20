import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
}));

vi.mock('../database/schema', () => ({
  queryAll: db.queryAll,
  queryOne: db.queryOne,
  runSQL: db.runSQL,
}));

vi.mock('../cache/redis', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  rateLimitRedis: null,
  default: null,
}));

const { default: chatbotRoutes } = await import('./chatbot');

const app = express();
app.use(express.json());
app.use('/api/chatbot', chatbotRoutes);

const knowledgeRows = [
  {
    id: 'kb-1',
    intent_id: 'intent-about',
    intent_name: 'about',
    language: 'en',
    question: 'What does Yemisrach Dimts do?',
    alternative_questions: JSON.stringify(['Who are you']),
    keywords: JSON.stringify(['ministry', 'media']),
    answer: 'We are a Christian media ministry.',
    priority: 10,
    source_type: 'manual',
    source_url: null,
  },
  {
    id: 'kb-2',
    intent_id: 'intent-contact',
    intent_name: 'contact',
    language: 'am',
    question: 'እንዴት ልናገኝዎት እንችላለሁ?',
    alternative_questions: '[]',
    keywords: JSON.stringify(['አድራሻ', 'ኢሜል']),
    answer: 'በinfo@yemisrachdimts.org ሊያገኙን ይችላሉ።',
    priority: 5,
    source_type: 'manual',
    source_url: null,
  },
];

beforeEach(() => {
  db.queryAll.mockReset();
  db.queryOne.mockReset();
  db.runSQL.mockReset();
  db.queryAll.mockImplementation((sql: string) => {
    if (sql.includes('chatbot_settings')) return Promise.resolve([]);
    if (sql.includes('chatbot_knowledge')) return Promise.resolve(knowledgeRows);
    return Promise.resolve([]);
  });
  db.queryOne.mockResolvedValue(null);
  db.runSQL.mockResolvedValue(undefined);
});

describe('public chatbot routes', () => {
  it('matches a question against database knowledge and persists the conversation', async () => {
    const res = await request(app)
      .post('/api/chatbot/message')
      .send({ sessionId: 'visitor-session-1', message: 'What does Yemisrach Dimts do?', lang: 'en' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reply: 'We are a Christian media ministry.',
      matched: true,
      language: 'en',
    });
    expect(String(res.body.intent)).toBeTruthy();
    expect(db.runSQL).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chatbot_messages'),
      expect.arrayContaining(['visitor', 'What does Yemisrach Dimts do?'])
    );
    expect(db.runSQL).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO chatbot_messages'),
      expect.arrayContaining(['bot', 'We are a Christian media ministry.'])
    );
  });

  it('uses the configured fallback and still records an unanswered message', async () => {
    db.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('chatbot_settings')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const res = await request(app)
      .post('/api/chatbot/message')
      .send({ sessionId: 'visitor-session-2', message: 'something completely unknown', lang: 'en' });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
    expect(res.body.reply).toMatch(/couldn't find a reliable answer/i);
    const botInsert = db.runSQL.mock.calls.find(
      (call) => String(call[0]).includes('INSERT INTO chatbot_messages') && call[1]?.[2] === 'bot'
    );
    expect(botInsert?.[1][4]).toBeNull();
  });

  it('answers in the selected language', async () => {
    const res = await request(app)
      .post('/api/chatbot/message')
      .send({ sessionId: 'visitor-session-3', message: 'እንዴት ልናገኝዎት እንችላለሁ?', lang: 'am' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('በinfo@yemisrachdimts.org ሊያገኙን ይችላሉ።');
    expect(res.body.language).toBe('am');
  });

  it('serves suggestions from approved knowledge', async () => {
    const res = await request(app).get('/api/chatbot/suggestions?lang=en');

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toContain('What does Yemisrach Dimts do?');
  });

  it('rejects empty messages', async () => {
    const res = await request(app).post('/api/chatbot/message').send({ message: '' });
    expect(res.status).toBe(400);
  });
});
