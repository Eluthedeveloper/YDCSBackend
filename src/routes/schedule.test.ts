import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

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
  getPool: () => ({
    getConnection: async () => ({
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute: db.runSQL,
    }),
  }),
  initDB: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../cache/redis', async () => {
  const actual = await vi.importActual<typeof import('../cache/redis')>('../cache/redis');
  return {
    ...actual,
    default: null,
    rateLimitRedis: null,
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn(),
    cacheDelete: vi.fn().mockResolvedValue(undefined),
    cacheInvalidate: vi.fn().mockResolvedValue(undefined),
  };
});

const { createApp } = await import('../index');
const jwt = (await import('jsonwebtoken')).default;
const { cacheDelete } = await import('../cache/redis');

const SECRET = 'test-secret-do-not-use-anywhere-else';

const ADMIN = {
  id: 'user-admin',
  username: 'admin',
  role: 'admin',
  token_version: 0,
};

const SUPER = { ...ADMIN, id: 'user-super', username: 'super', role: 'super_admin' };

let app: ReturnType<typeof createApp>['app'];

function cookieFor(role: 'admin' | 'super_admin') {
  const payload = role === 'admin' ? ADMIN : SUPER;
  const token = jwt.sign(
    { id: payload.id, username: payload.username, role, tokenVersion: 0 },
    SECRET,
    { expiresIn: 3600 }
  );
  return `ydcs_session=${token}`;
}

/**
 * Queues `queryOne` answers in call order. `authenticate` always performs the
 * first lookup (it must see a real user row with a token_version), so the auth
 * row is enqueued first and the route's own lookups follow it.
 */
function authThen(...routeRows: unknown[]) {
  db.queryOne.mockReset();
  db.queryOne.mockResolvedValueOnce({ id: ADMIN.id, token_version: 0 });
  for (const row of routeRows) db.queryOne.mockResolvedValueOnce(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ app } = createApp());
});

const SLOT = { id: 'slot-1', day: 'Mon', hour: 2, title: 'Morning Devotion', host: 'Amharic Team', category: 'teaching' };

describe('GET /api/site/schedule', () => {
  it('returns the weekly grid for anonymous visitors', async () => {
    db.queryAll.mockResolvedValueOnce([SLOT]);
    const res = await request(app).get('/api/site/schedule');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([SLOT]);
  });
});

describe('PUT /api/site/schedule', () => {
  it('requires an admin session', async () => {
    const res = await request(app).put('/api/site/schedule').send({});
    expect(res.status).toBe(401);
  });

  it('upserts a slot and drops the schedule cache', async () => {
    authThen();
    db.runSQL.mockResolvedValueOnce(undefined);
    const res = await request(app)
      .put('/api/site/schedule')
      .set('Cookie', cookieFor('admin'))
      .send({ day: 'Mon', hour: 2, title: 'New Devotion', host: 'New Host', category: 'worship' });
    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO radio_schedule/),
      expect.arrayContaining(['Mon', 2, 'New Devotion'])
    );
    expect(cacheDelete).toHaveBeenCalledWith('public:site:schedule');
  });

  it('rejects an invalid day', async () => {
    authThen();
    const res = await request(app)
      .put('/api/site/schedule')
      .set('Cookie', cookieFor('admin'))
      .send({ day: 'Someday', hour: 2, title: 'x', category: 'talk' });
    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects an hour outside the day', async () => {
    authThen();
    const res = await request(app)
      .put('/api/site/schedule')
      .set('Cookie', cookieFor('admin'))
      .send({ day: 'Mon', hour: 24, title: 'x', category: 'talk' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty title', async () => {
    authThen();
    const res = await request(app)
      .put('/api/site/schedule')
      .set('Cookie', cookieFor('admin'))
      .send({ day: 'Mon', hour: 2, title: '  ', category: 'talk' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/site/schedule/:id', () => {
  it('requires a super admin', async () => {
    authThen({ id: 'slot-1' });
    const res = await request(app).delete('/api/site/schedule/slot-1').set('Cookie', cookieFor('admin'));
    expect(res.status).toBe(403);
    expect(db.runSQL).not.toHaveBeenCalledWith('DELETE FROM radio_schedule WHERE id = ?', 'slot-1');
  });

  it('deletes the slot and drops the cache for a super admin', async () => {
    authThen({ id: 'slot-1' });
    db.runSQL.mockResolvedValueOnce(undefined);
    const res = await request(app).delete('/api/site/schedule/slot-1').set('Cookie', cookieFor('super_admin'));
    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledWith('DELETE FROM radio_schedule WHERE id = ?', ['slot-1']);
    expect(cacheDelete).toHaveBeenCalledWith('public:site:schedule');
  });

  it('404s on an unknown slot', async () => {
    authThen(null);
    const res = await request(app).delete('/api/site/schedule/nope').set('Cookie', cookieFor('super_admin'));
    expect(res.status).toBe(404);
  });
});
