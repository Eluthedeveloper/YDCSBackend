import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const cache = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  invalidate: vi.fn(),
}));

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
}));

vi.mock('../cache/redis', async () => {
  const actual = await vi.importActual<typeof import('../cache/redis')>('../cache/redis');
  return {
    ...actual,
    default: null,
    rateLimitRedis: null,
    cacheGet: cache.get,
    cacheSet: cache.set,
    cacheDelete: cache.del,
    cacheInvalidate: cache.invalidate,
  };
});

const { createApp } = await import('../index');

const SECRET = process.env.JWT_SECRET as string;

const ADMIN = { id: 'user-admin', username: 'admin', role: 'admin' };

const PROGRAM_IDS = ['program-one', 'program-two', 'program-three'];

let app: ReturnType<typeof createApp>['app'];

function tokenFor(user: { id: string; username: string; role: string }) {
  return jwt.sign({ ...user, tokenVersion: 0 }, SECRET, { expiresIn: '1h' });
}

function cookieHeader(token: string) {
  return `ydcs_session=${token}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.del.mockResolvedValue(undefined);
  // authenticate() re-reads the user's token_version on every request.
  db.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/SELECT id, token_version FROM users WHERE id/.test(sql)) {
      return { id: params[0], token_version: 0 };
    }
    return undefined;
  });
  db.queryAll.mockResolvedValue(PROGRAM_IDS.map((id) => ({ id })));
  db.runSQL.mockResolvedValue(undefined);
  db.withTransaction.mockImplementation(async (fn: (conn: unknown) => unknown) =>
    fn({ execute: db.runSQL })
  );
  ({ app } = createApp());
});

describe('PUT /api/programs/reorder', () => {
  it('writes the positions in the order the admin sent', async () => {
    const order = [...PROGRAM_IDS].reverse();

    const res = await request(app)
      .put('/api/programs/reorder')
      .set('Cookie', cookieHeader(tokenFor(ADMIN)))
      .send({ order });

    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledTimes(order.length);
    expect(db.runSQL).toHaveBeenNthCalledWith(1, 'UPDATE programs SET sort_order = ? WHERE id = ?', [1, order[0]]);
    expect(db.runSQL).toHaveBeenNthCalledWith(3, 'UPDATE programs SET sort_order = ? WHERE id = ?', [3, order[2]]);
    // The list order is cached, so a save that forgets this leaves the old
    // arrangement on every visitor's screen for the cache TTL.
    expect(cache.del).toHaveBeenCalledWith(
      'public:programs',
      'public:latest-tracks',
      'public:listens:stats',
      'admin:analytics'
    );
  });

  it('rejects a body that is not an array', async () => {
    const res = await request(app)
      .put('/api/programs/reorder')
      .set('Cookie', cookieHeader(tokenFor(ADMIN)))
      .send({ order: 'program-one' });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids instead of writing one position twice', async () => {
    const res = await request(app)
      .put('/api/programs/reorder')
      .set('Cookie', cookieHeader(tokenFor(ADMIN)))
      .send({ order: ['program-one', 'program-one'] });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects ids that are not in the catalogue', async () => {
    db.queryAll.mockResolvedValue([{ id: 'program-one' }]);

    const res = await request(app)
      .put('/api/programs/reorder')
      .set('Cookie', cookieHeader(tokenFor(ADMIN)))
      .send({ order: ['program-one', 'program-ghost'] });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('requires an authenticated admin', async () => {
    const res = await request(app)
      .put('/api/programs/reorder')
      .send({ order: PROGRAM_IDS });

    expect(res.status).toBe(401);
    expect(db.runSQL).not.toHaveBeenCalled();
  });
});
