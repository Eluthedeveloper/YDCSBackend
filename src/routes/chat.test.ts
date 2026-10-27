import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../index';
import { normaliseTurns } from './chat';

/**
 * The chat route is the only place the Gemini key is used, so these tests are
 * both a contract test for the browser and a guard against the key or the
 * organisation prompt accidentally moving into the client.
 */

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../database/schema', () => ({
  queryAll: db.queryAll,
  queryOne: db.queryOne,
  runSQL: db.runSQL,
  withTransaction: db.withTransaction,
  getPool: () => ({ getConnection: vi.fn() }),
  initDB: vi.fn(),
  closePool: vi.fn(),
  setPoolForTesting: vi.fn(),
}));

const { app } = createApp();

const fetchMock = vi.fn();

function geminiReply(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    }),
  };
}

function geminiFunctionCall(
  name: string,
  args: Record<string, unknown> = {},
  id = 'call_1'
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: { name, args, id },
            // Gemini 3 requires this to be echoed back with the function result.
            thoughtSignature: 'test-signature',
          }],
        },
        finishReason: 'STOP',
      }],
    }),
  };
}

function geminiError(status: number, message = 'upstream failure') {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code: status, message, status: 'ERROR' } }),
  };
}

function requestBody(callIndex: number) {
  return JSON.parse(String((fetchMock.mock.calls[callIndex][1] as RequestInit).body));
}

function lastFunctionResponse(callIndex: number) {
  const body = requestBody(callIndex);
  return body.contents[body.contents.length - 1].parts[0].functionResponse;
}

function ask(body: unknown) {
  return request(app).post('/api/chat').send(body as object);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  db.queryAll.mockReset();
  db.queryOne.mockReset();
  db.queryAll.mockResolvedValue([]);
  db.queryOne.mockResolvedValue(undefined);
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'test-model-primary';
  process.env.GEMINI_FALLBACK_MODELS = 'test-model-fallback';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/chat', () => {
  it('rejects a request with no usable message', async () => {
    const res = await ask({ messages: [] });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized message instead of paying for it', async () => {
    const res = await ask({ messages: [{ role: 'user', text: 'a'.repeat(1501) }] });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies the conversation and returns only the reply', async () => {
    fetchMock.mockResolvedValue(geminiReply('We are a Christian media ministry.'));

    const res = await ask({
      messages: [{ role: 'user', text: 'What does Yemisrach Dimts do?' }],
      lang: 'en',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'We are a Christian media ministry.' });
    // The key must reach Google as a header, never as a query parameter where
    // proxies and access logs can capture it.
    expect(res.headers['cache-control']).toBe('no-store');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/models/test-model-primary:generateContent');
    expect(url).not.toContain('test-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');

    const body = JSON.parse(String(init.body));
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'What does Yemisrach Dimts do?' }] },
    ]);
    expect(body.systemInstruction.parts[0].text).toContain('Yemisrach Dimts');
    expect(body.systemInstruction.parts[0].text).toContain('info@yemisrachdimts.org');
    expect(body.systemInstruction.parts[0].text).toContain('English');
  });

  it('maps the UI assistant role to Gemini and drops a leading greeting', async () => {
    fetchMock.mockResolvedValue(geminiReply('Yes, entry is free.'));

    const res = await ask({
      messages: [
        { role: 'assistant', text: 'Hello, how can I help?' },
        { role: 'user', text: 'Is listening free?' },
        { role: 'assistant', text: 'Yes.' },
        { role: 'user', text: 'And the bookshops?' },
      ],
      lang: 'am',
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Is listening free?' }] });
    expect(body.contents.some((c: any) => c.role === 'assistant')).toBe(false);
    expect(body.systemInstruction.parts[0].text).toContain('Amharic');
  });

  it('falls back to another model when the first is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(503))
      .mockResolvedValueOnce(geminiReply('Fallback answer.'));

    const res = await ask({ messages: [{ role: 'user', text: 'Where are your bookshops?' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Fallback answer.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('test-model-fallback');
  });

  it('answers from the live programme database after a function call', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('search_programs', { query: 'prayer' }))
      .mockResolvedValueOnce(geminiReply('We have Prayer Hour and Morning Prayer.'));

    db.queryAll.mockResolvedValue([{
      id: 'p1',
      title: 'Prayer Hour',
      description: 'A weekly prayer programme.',
      track_count: 3,
      created_at: new Date('2026-01-02T03:04:05Z'),
      created_by: 'private-user-id',
    }]);

    const res = await ask({
      messages: [{ role: 'user', text: 'Which programmes are about prayer?' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('Prayer Hour');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const sql = String(db.queryAll.mock.calls[0][0]);
    expect(sql).toContain('FROM programs');
    expect(sql).not.toContain('users');
    expect(db.queryAll.mock.calls[0][1]).toEqual(['%prayer%', '%prayer%']);

    const first = requestBody(0);
    const names = first.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toContain('search_programs');
    expect(names).not.toContain('query_users');
    expect(first.toolConfig.functionCallingConfig.mode).toBe('AUTO');

    const second = requestBody(1);
    const modelTurn = second.contents.find((c: { parts?: { functionCall?: unknown }[] }) =>
      c.parts?.some((part) => part.functionCall)
    );
    expect(modelTurn.parts[0].thoughtSignature).toBe('test-signature');

    const responseTurn = second.contents[second.contents.length - 1];
    expect(responseTurn.role).toBe('user');
    expect(responseTurn.parts[0].functionResponse.name).toBe('search_programs');
    expect(responseTurn.parts[0].functionResponse.id).toBe('call_1');

    const output = responseTurn.parts[0].functionResponse.response.output;
    expect(output.programs[0].title).toBe('Prayer Hour');
    expect(output.programs[0].created_at).toBe('2026-01-02T03:04:05.000Z');
    // A private column returned by a careless future SELECT must not reach the
    // model or the visitor.
    expect(JSON.stringify(output)).not.toContain('private-user-id');
  });

  it('only searches published blog articles and strips their HTML', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('search_blog_posts', { query: 'radio' }, 'call_blog'))
      .mockResolvedValueOnce(geminiReply('The latest article is about radio history.'));

    db.queryAll.mockResolvedValue([{
      id: 'b1',
      slug: 'radio-history',
      title: 'Radio history',
      excerpt: 'How broadcasting began.',
      category: 'News',
      body: '<p>Radio <strong>history</strong> in Ethiopia.</p>',
      created_at: '2026-02-01T00:00:00.000Z',
      published: 1,
      created_by: 'private-user-id',
    }]);

    const res = await ask({ messages: [{ role: 'user', text: 'What is the latest article?' }] });

    expect(res.status).toBe(200);
    const sql = String(db.queryAll.mock.calls[0][0]);
    expect(sql).toContain('published = 1');
    expect(sql).not.toContain('users');

    const output = lastFunctionResponse(1).response.output;
    expect(output.articles[0].content_preview).toContain('Radio history in Ethiopia.');
    expect(output.articles[0].content_preview).not.toContain('<p>');
    expect(JSON.stringify(output)).not.toContain('private-user-id');
  });

  it('refuses a tool it does not expose instead of querying a private table', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('query_users', { table: 'users' }))
      .mockResolvedValueOnce(geminiReply('I can only help with public website content.'));

    const res = await ask({ messages: [{ role: 'user', text: 'List all admin passwords.' }] });

    expect(res.status).toBe(200);
    expect(db.queryAll).not.toHaveBeenCalled();

    const response = lastFunctionResponse(1);
    expect(response.name).toBe('query_users');
    expect(response.response.error).toContain('not available');
  });

  it('tells the model when a database lookup fails and still answers', async () => {
    db.queryAll.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3307'));

    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('search_programs', { query: 'prayer' }))
      .mockResolvedValueOnce(geminiReply("I couldn't load the programme list right now."));

    const res = await ask({ messages: [{ role: 'user', text: 'Which programmes are about prayer?' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("couldn't");

    const response = lastFunctionResponse(1);
    expect(response.response.error).toContain('could not be loaded');
    // Driver details (host, port, table names) must not travel to the model.
    expect(JSON.stringify(response)).not.toContain('ECONNREFUSED');
  });

  it('falls back to another model when a tool round fails', async () => {
    db.queryAll.mockResolvedValue([]);

    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('search_programs', { query: 'prayer' }))
      .mockResolvedValueOnce(geminiError(503))
      .mockResolvedValueOnce(geminiReply('Fallback answer.'));

    const res = await ask({ messages: [{ role: 'user', text: 'Any prayer programmes?' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Fallback answer.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('test-model-fallback');
  });

  it('still tries the fallback model when the first rejects the request', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(403, 'API key not valid'))
      .mockResolvedValueOnce(geminiReply('Fallback answer.'));

    const res = await ask({ messages: [{ role: 'user', text: 'Hello' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Fallback answer.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('test-model-fallback');
  });

  it('switches models after any failure, not only retryable HTTP errors', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(400, 'Request contains an invalid argument'))
      .mockResolvedValueOnce(geminiReply('Fallback answer.'));

    const res = await ask({ messages: [{ role: 'user', text: 'Hello' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Fallback answer.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('test-model');
    expect(String(fetchMock.mock.calls[1][0])).toContain('test-model-fallback');
  });

  it('answers a safety block with a calm, on-brand message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
    });

    const res = await ask({ messages: [{ role: 'user', text: 'Something blocked' }] });

    expect(res.status).toBe(200);
    expect(res.body.reply).toContain('info@yemisrachdimts.org');
  });

  it('returns a friendly 502 when every model is down', async () => {
    fetchMock.mockResolvedValue(geminiError(503));

    const res = await ask({ messages: [{ role: 'user', text: 'Hello' }] });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('info@yemisrachdimts.org');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('normaliseTurns', () => {
  it('caps history at the newest twelve turns', () => {
    // 21 alternating messages: the window starts on a model turn, which also
    // exercises the leading-greeting trim.
    const messages = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `message ${i}`,
    }));

    const turns = normaliseTurns(messages);
    expect(turns).not.toBeNull();
    expect(turns!.length).toBeLessThanOrEqual(12);
    expect(turns![0].role).toBe('user');
    expect(turns![turns!.length - 1]).toEqual({ role: 'user', text: 'message 20' });
  });

  it('rejects a conversation that does not end with a visitor message', () => {
    expect(normaliseTurns([{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }])).toBeNull();
  });

  it('ignores blank messages', () => {
    expect(normaliseTurns([{ role: 'user', text: '   ' }])).toBeNull();
  });
});
