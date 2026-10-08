import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
  withTransaction: vi.fn(),
}));

// The uploaded file multer would have written to disk. Every failure path after
// the bytes land has to unlink it, so the deletion is what these tests assert.
const unlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Both routers import the default (`import fs from 'fs/promises'`), so the
// patched object has to be the default export, not just a named one.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  const patched = { ...actual, unlink };
  return { ...patched, default: patched };
});

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

// multer writes to disk before the handler runs. The real storage engine is kept
// (both routers call `multer.diskStorage` at import time) but the middleware is
// replaced, so the test never touches the filesystem while still producing the
// `req.file` shape the routes read.
vi.mock('multer', async () => {
  const actual = await vi.importActual<typeof import('multer')>('multer');
  const factory = (options: Record<string, unknown>) => ({
    ...options,
    single: () => (req: { file?: unknown }, _res: unknown, next: () => void) => {
      req.file = { filename: 'track-uuid.mp3', originalname: 'song.mp3', mimetype: 'audio/mpeg' };
      next();
    },
    array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  });
  return {
    ...actual,
    default: Object.assign(factory, {
      diskStorage: actual.diskStorage,
      memoryStorage: actual.memoryStorage,
    }),
  };
});

const { createApp } = await import('../index');
const jwt = (await import('jsonwebtoken')).default;

const SECRET = 'test-secret-do-not-use-anywhere-else';

const ADMIN = {
  id: 'user-admin',
  username: 'admin',
  email: 'admin@audio.com',
  role: 'admin',
  token_version: 0,
};

let app: ReturnType<typeof createApp>['app'];

function adminCookie() {
  const token = jwt.sign(
    { id: ADMIN.id, username: ADMIN.username, role: ADMIN.role, tokenVersion: 0 },
    SECRET,
    { expiresIn: 3600 }
  );
  return `ydcs_session=${token}`;
}

/**
 * Posts to the upload route.
 *
 * Multer is mocked, so nothing parses a multipart body here; the fields are sent
 * as JSON instead. That is equivalent for what the routes read: `duration: '213'`
 * below is exactly the string multer would have produced, and `title: ['a','b']`
 * is exactly the array it produces for a repeated field. The route reads
 * `req.body` without caring which parser filled it.
 */
function upload(fields: Record<string, unknown>) {
  return request(app)
    .post('/api/tracks')
    .set('Cookie', adminCookie())
    .send(fields);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = SECRET;
  unlink.mockResolvedValue(undefined);
  db.queryAll.mockResolvedValue([]);
  db.runSQL.mockResolvedValue(undefined);
  // `authenticate` verifies the token on every request, then the route looks up
  // the program it needs. Both resolve through queryOne.
  db.queryOne.mockResolvedValue({ id: 'p1', token_version: 0, program_id: 'p1' });
  // The upload reserves its sort_order and inserts inside one transaction, so
  // the mocked connection has to answer the reservation as a rowset.
  db.withTransaction.mockImplementation(async (fn: (conn: unknown) => unknown) =>
    fn({
      execute: async (sql: string, params?: unknown[]) => {
        if (/MAX\(sort_order\)/.test(sql)) return [[{ next: 7 }], []];
        await db.runSQL(sql, params);
        return [{ affectedRows: 1 }, []];
      },
    })
  );
  ({ app } = createApp());
});

describe('POST /api/tracks duration', () => {
  // A multipart body delivers every field as a string. The guard used to demand
  // `typeof duration === 'number'`, so any client sending a duration got a 400
  // and every track was created with duration 0.
  it('accepts a duration sent as a string, the way a multipart body delivers it', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1', duration: '213.5' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain(213.5);
  });

  it('defaults to 0 when no duration is sent', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain(0);
  });

  it('rejects a non-numeric duration instead of storing NaN', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1', duration: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalled();
  });

  // isNaN(Infinity) is false, so the old check let Infinity through to a DOUBLE
  // column that rejects it.
  it('rejects an infinite duration', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1', duration: 'Infinity' });

    expect(res.status).toBe(400);
  });

  it('rejects a negative duration', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1', duration: '-5' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/tracks orphaned uploads', () => {
  // Every validation branch ran cleanupFiles, but the INSERT was unguarded: a
  // DB failure left the uploaded audio on disk with no row to ever find it by.
  it('deletes the uploaded file when the insert fails', async () => {
    db.runSQL.mockRejectedValue(new Error('ER_LOCK_DEADLOCK'));

    const res = await upload({ title: 'Song', program_id: 'p1' });

    expect(res.status).toBe(500);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('track-uuid.mp3'));
  });

  // `?title=a&title=b` reaches the route as an array. `.trim()` on it threw a
  // TypeError and the array itself failed the mysql2 bind, both surfacing as 500s.
  it('rejects a repeated title field with a 400 rather than a 500', async () => {
    const res = await upload({ title: ['a', 'b'], program_id: 'p1' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalled();
  });

  it('rejects a missing title', async () => {
    const res = await upload({ program_id: 'p1' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalled();
  });

  it('rejects a title past the column width', async () => {
    const res = await upload({ title: 'x'.repeat(300), program_id: 'p1' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalled();
  });
});

describe('POST /api/tracks sort order', () => {
  // sort_order used to be COUNT(*), which reuses a live value after a delete
  // from the middle of a list and collides outright on concurrent uploads.
  it('reserves MAX(sort_order) + 1 under a row lock rather than counting rows', async () => {
    const res = await upload({ title: 'Song', program_id: 'p1' });

    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(7);

    const reservation = db.withTransaction.mock.calls.length;
    expect(reservation).toBe(1);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain(7);
  });
});

describe('PUT /api/tracks/reorder/:programId', () => {
  // One UPDATE per id on a single pooled connection, so an unbounded array
  // monopolises a slot from the pool of 10 for as long as it runs.
  it('rejects more ids than the reorder cap', async () => {
    const res = await request(app)
      .put('/api/tracks/reorder/p1')
      .set('Cookie', adminCookie())
      .send({ trackIds: Array.from({ length: 51 }, (_, i) => `t${i}`) });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects non-string ids rather than failing the mysql2 bind', async () => {
    const res = await request(app)
      .put('/api/tracks/reorder/p1')
      .set('Cookie', adminCookie())
      .send({ trackIds: ['t1', { nested: true }] });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('accepts a list within the cap', async () => {
    const res = await request(app)
      .put('/api/tracks/reorder/p1')
      .set('Cookie', adminCookie())
      .send({ trackIds: ['t1', 't2', 't3'] });

    expect(res.status).toBe(200);
  });
});