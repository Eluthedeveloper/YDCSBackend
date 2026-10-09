import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
  withTransaction: vi.fn(),
}));

// The uploaded files multer would have written to disk. Every failure path
// after the bytes land has to unlink them, so the deletion is what these
// tests assert.
const unlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Files the mocked `array` middleware injects, per test.
const multerState = vi.hoisted(() => ({ files: [] as unknown[] }));

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
// (the router calls `multer.diskStorage` at import time) but the middleware is
// replaced, so the test never touches the filesystem while still producing the
// `req.file` / `req.files` shapes the routes read.
vi.mock('multer', async () => {
  const actual = await vi.importActual<typeof import('multer')>('multer');
  const factory = (options: Record<string, unknown>) => ({
    ...options,
    single: () => (req: { file?: unknown }, _res: unknown, next: () => void) => {
      req.file = { filename: 'leader-uuid.jpg', originalname: 'leader.jpg', mimetype: 'image/jpeg' };
      next();
    },
    array: () => (req: { files?: unknown }, _res: unknown, next: () => void) => {
      req.files = multerState.files;
      next();
    },
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
const { cacheGet, cacheSet, cacheDelete } = await import('../cache/redis');

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
  db.queryOne.mockResolvedValue({ id: ADMIN.id, token_version: 0 });
  db.queryOne.mockResolvedValueOnce({ id: ADMIN.id, token_version: 0 });
  for (const row of routeRows) db.queryOne.mockResolvedValueOnce(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = SECRET;
  unlink.mockResolvedValue(undefined);
  db.queryAll.mockResolvedValue([]);
  db.runSQL.mockResolvedValue(undefined);
  db.queryOne.mockResolvedValue({ id: ADMIN.id, token_version: 0 });
  db.withTransaction.mockImplementation(async (fn: (conn: unknown) => unknown) =>
    fn({
      execute: async (sql: string, params?: unknown[]) => {
        await db.runSQL(sql, params);
        return [{ affectedRows: 1 }, []];
      },
    })
  );
  (cacheGet as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  multerState.files = [
    { filename: 'photo-1.jpg', originalname: 'one.jpg', mimetype: 'image/jpeg' },
    { filename: 'photo-2.jpg', originalname: 'two.jpg', mimetype: 'image/jpeg' },
  ];
  ({ app } = createApp());
});

describe('GET /api/site reads', () => {
  // The homepage pulls these lists anonymously; a cache miss must repopulate
  // the key the write path invalidates, or edits never become visible.
  it('serves leaders from the database and caches them', async () => {
    db.queryAll.mockResolvedValue([{ id: 'l1', name: 'Pastor A' }]);

    const res = await request(app).get('/api/site/leaders');

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Pastor A');
    expect(cacheGet).toHaveBeenCalledWith('public:site:leaders');
    expect(cacheSet).toHaveBeenCalledWith('public:site:leaders', expect.any(Array), 300);
  });

  it('answers a leader cache hit without touching the database', async () => {
    (cacheGet as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'cached' }]);

    const res = await request(app).get('/api/site/leaders');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'cached' }]);
    expect(db.queryAll).not.toHaveBeenCalled();
  });

  // Pinned announcements must sort above unpinned ones or "pinning" has no
  // visible effect anywhere.
  it('orders announcements pinned first, newest first', async () => {
    await request(app).get('/api/site/announcements');

    const sql = db.queryAll.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ORDER BY pinned DESC, created_at DESC');
  });

  it('orders events newest date first so upcoming events survive the limit', async () => {
    await request(app).get('/api/site/events');

    const sql = db.queryAll.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ORDER BY starts_at DESC');
  });

  // The Gallery shows a cover grid: each album has to arrive with its own
  // photos already attached, otherwise the page fires one request per album.
  it('embeds each album with its photos', async () => {
    db.queryAll
      .mockResolvedValueOnce([{ id: 'a1', title: 'Baptism 2026' }])
      .mockResolvedValueOnce([{ id: 'p1', album_id: 'a1', file_name: 'x.jpg' }]);

    const res = await request(app).get('/api/site/albums');

    expect(res.status).toBe(200);
    expect(res.body[0].photos).toHaveLength(1);
    expect(db.queryAll.mock.calls[1]?.[1]).toEqual(['a1', 500]);
  });
});

describe('POST /api/site/leaders', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/site/leaders').send({ name: 'A', title: 'B' });

    expect(res.status).toBe(401);
  });

  it('creates a leader, reserves the next sort position, and drops the cache', async () => {
    authThen({ next: 5 });

    const res = await request(app)
      .post('/api/site/leaders')
      .set('Cookie', cookieFor('admin'))
      .send({ name: 'Pastor A', title: 'Senior Pastor' });

    expect(res.status).toBe(201);
    expect(res.body.sort_order).toBe(5);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO leaders/.test(c[0] as string));
    expect(insert?.[1]).toContain(5);
    expect(cacheDelete).toHaveBeenCalledWith('public:site:leaders');
  });

  // The photo multer already wrote has no row to live under once validation
  // fails, so every rejection has to take the file with it.
  it('rejects a missing name and deletes the uploaded photo', async () => {
    const res = await request(app)
      .post('/api/site/leaders')
      .set('Cookie', cookieFor('admin'))
      .send({ title: 'Senior Pastor' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('leader-uuid.jpg'));
  });

  it('rejects a name past the column width', async () => {
    const res = await request(app)
      .post('/api/site/leaders')
      .set('Cookie', cookieFor('admin'))
      .send({ name: 'x'.repeat(300), title: 'T' });

    expect(res.status).toBe(400);
    expect(unlink).toHaveBeenCalled();
  });

  it('deletes the photo when the insert fails', async () => {
    authThen();
    db.runSQL.mockRejectedValue(new Error('ER_LOCK_DEADLOCK'));

    const res = await request(app)
      .post('/api/site/leaders')
      .set('Cookie', cookieFor('admin'))
      .send({ name: 'A', title: 'B' });

    expect(res.status).toBe(500);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('leader-uuid.jpg'));
  });
});

describe('PUT /api/site/leaders/reorder', () => {
  // One UPDATE per id on a single pooled connection, so an unbounded array
  // monopolises a slot from the pool for as long as it runs.
  it('rejects more ids than the reorder cap', async () => {
    const res = await request(app)
      .put('/api/site/leaders/reorder')
      .set('Cookie', cookieFor('admin'))
      .send({ ids: Array.from({ length: 101 }, (_, i) => `l${i}`) });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects non-string ids rather than failing the mysql2 bind', async () => {
    const res = await request(app)
      .put('/api/site/leaders/reorder')
      .set('Cookie', cookieFor('admin'))
      .send({ ids: ['l1', { nested: true }] });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('writes the new positions', async () => {
    const res = await request(app)
      .put('/api/site/leaders/reorder')
      .set('Cookie', cookieFor('admin'))
      .send({ ids: ['l2', 'l1'] });

    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledWith(expect.stringContaining('UPDATE leaders SET sort_order'), [0, 'l2']);
    expect(db.runSQL).toHaveBeenCalledWith(expect.stringContaining('UPDATE leaders SET sort_order'), [1, 'l1']);
  });
});

describe('POST /api/site/events', () => {
  // The form posts `datetime-local` (`2026-11-02T18:30`); storing it verbatim
  // would insert a malformed DATETIME in strict mode.
  it('normalises a datetime-local value into a MySQL DATETIME', async () => {
    const res = await request(app)
      .post('/api/site/events')
      .set('Cookie', cookieFor('admin'))
      .send({ title: 'Youth Night', starts_at: '2026-11-02T18:30' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO events/.test(c[0] as string));
    expect(insert?.[1]).toContain('2026-11-02 18:30:00');
  });

  it('rejects an unparseable start date instead of storing garbage', async () => {
    const res = await request(app)
      .post('/api/site/events')
      .set('Cookie', cookieFor('admin'))
      .send({ title: 'Youth Night', starts_at: 'next tuesday' });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects an end before the start', async () => {
    const res = await request(app)
      .post('/api/site/events')
      .set('Cookie', cookieFor('admin'))
      .send({ title: 'Youth Night', starts_at: '2026-11-02T18:30', ends_at: '2026-11-02T17:00' });

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });
});

describe('POST /api/site/albums/:id/photos', () => {
  it('rejects an empty batch', async () => {
    multerState.files = [];

    const res = await request(app)
      .post('/api/site/albums/a1/photos')
      .set('Cookie', cookieFor('admin'));

    expect(res.status).toBe(400);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects the batch when the album does not exist', async () => {
    authThen(undefined);

    const res = await request(app)
      .post('/api/site/albums/a1/photos')
      .set('Cookie', cookieFor('admin'));

    expect(res.status).toBe(404);
    // The files were written before the album lookup failed; nothing references
    // them now, so both must go.
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('photo-1.jpg'));
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('photo-2.jpg'));
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('inserts every photo in one transaction and clears the albums cache', async () => {
    authThen({ id: 'a1', title: 'Baptism' });

    const res = await request(app)
      .post('/api/site/albums/a1/photos')
      .set('Cookie', cookieFor('admin'))
      .send({ captions: ['First', 'Second'] });

    expect(res.status).toBe(201);
    expect(res.body.uploaded).toBe(2);
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('public:site:albums');
  });

  // Without the transaction, a failure on photo 2 would leave photo 1's row
  // committed while this handler deletes both files from disk.
  it('rolls the batch back and removes every file when an insert fails', async () => {
    authThen({ id: 'a1', title: 'Baptism' });
    db.runSQL.mockRejectedValue(new Error('ER_BAD_NULL_ERROR'));

    const res = await request(app)
      .post('/api/site/albums/a1/photos')
      .set('Cookie', cookieFor('admin'));

    expect(res.status).toBe(500);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('photo-1.jpg'));
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('photo-2.jpg'));
  });
});

describe('DELETE /api/site permissions', () => {
  // Removals are super-admin only, so a co-admin account cannot silently wipe
  // content the public site depends on.
  it('forbids an admin from deleting an announcement', async () => {
    authThen({ id: 'n1', title: 'Hello' });

    const res = await request(app)
      .delete('/api/site/announcements/n1')
      .set('Cookie', cookieFor('admin'));

    expect(res.status).toBe(403);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('lets a super admin delete an announcement and drops its cache', async () => {
    authThen({ id: 'n1', title: 'Hello' });

    const res = await request(app)
      .delete('/api/site/announcements/n1')
      .set('Cookie', cookieFor('super_admin'));

    expect(res.status).toBe(200);
    expect(cacheDelete).toHaveBeenCalledWith('public:site:announcements');
  });

  // The leader's photo is referenced only by that row; a delete that leaves the
  // file behind leaks it forever.
  it('lets a super admin delete a leader and unlinks its photo', async () => {
    authThen({ id: 'l1', photo: 'old.jpg' });

    const res = await request(app)
      .delete('/api/site/leaders/l1')
      .set('Cookie', cookieFor('super_admin'));

    expect(res.status).toBe(200);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('old.jpg'));
  });
});

describe('PUT /api/site/leaders/:id', () => {
  // A replaced photo must take the old file off disk or it stays referenced by
  // nothing.
  it('deletes the previous photo when a new one replaces it', async () => {
    authThen({ id: 'l1', name: 'A', title: 'B', quote: null, role_label: null, photo: 'old.jpg' });

    const res = await request(app)
      .put('/api/site/leaders/l1')
      .set('Cookie', cookieFor('admin'))
      .send({ name: 'A2', title: 'B2' });

    expect(res.status).toBe(200);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('old.jpg'));
    expect(cacheDelete).toHaveBeenCalledWith('public:site:leaders');
  });

  it('404s on an unknown leader and still cleans the uploaded file', async () => {
    authThen(undefined);

    const res = await request(app)
      .put('/api/site/leaders/missing')
      .set('Cookie', cookieFor('admin'))
      .send({ name: 'A' });

    expect(res.status).toBe(404);
    expect(unlink).toHaveBeenCalled();
  });
});
