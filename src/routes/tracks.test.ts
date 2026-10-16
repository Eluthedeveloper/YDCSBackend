import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs/promises';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
  withTransaction: vi.fn(),
}));

// The uploaded file multer would have written to disk. Every failure path after
// the bytes land has to unlink it, so the deletion is what these tests assert.
const unlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const tagReads = vi.hoisted(() => ({ readAudioTags: vi.fn() }));

vi.mock('../lib/audioTags', async () => {
  const actual = await vi.importActual<typeof import('../lib/audioTags')>('../lib/audioTags');
  return { ...actual, readAudioTags: tagReads.readAudioTags };
});

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
    // The blog routes in site.ts register a `fields()` upload at import time;
    // this router never uses it, so a passthrough keeps the module loadable.
    fields: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
const { cacheDelete } = await import('../cache/redis');
const { programReadCacheKeys } = await import('../lib/cacheKeys');

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

const SUPER_ADMIN = { ...ADMIN, id: 'user-super', username: 'super', role: 'super_admin' };

function superCookie() {
  const token = jwt.sign(
    { id: SUPER_ADMIN.id, username: SUPER_ADMIN.username, role: SUPER_ADMIN.role, tokenVersion: 0 },
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
  tagReads.readAudioTags.mockResolvedValue({ title: null, artist: null, album: null });
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

describe('POST /api/tracks metadata', () => {
  it('reads the tags of the stored file', async () => {
    tagReads.readAudioTags.mockResolvedValue({ title: 'Tagged Title', artist: 'Tagged Artist', album: null });

    const res = await upload({ title: 'Song', program_id: 'p1' });

    expect(res.status).toBe(201);
    expect(tagReads.readAudioTags).toHaveBeenCalledWith(expect.stringContaining('track-uuid.mp3'));
  });

  it('replaces a title copied from the file name with the tag title', async () => {
    tagReads.readAudioTags.mockResolvedValue({ title: 'Tagged Title', artist: 'Tagged Artist', album: 'Tagged Album' });

    const res = await upload({ title: 'song', artist: '', album: '', program_id: 'p1' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain('Tagged Title');
    expect(insert?.[1]).toContain('Tagged Artist');
    expect(insert?.[1]).toContain('Tagged Album');
    expect(res.body.title).toBe('Tagged Title');
    expect(res.body.artist).toBe('Tagged Artist');
  });

  it('keeps a title the admin typed that differs from the file name', async () => {
    tagReads.readAudioTags.mockResolvedValue({ title: 'Tagged Title', artist: 'Tagged Artist', album: null });

    const res = await upload({ title: 'Chosen title', artist: 'Chosen artist', program_id: 'p1' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain('Chosen title');
    expect(insert?.[1]).toContain('Chosen artist');
  });

  it('stores the file name as the title when neither side carries tags', async () => {
    const res = await upload({ title: 'song', program_id: 'p1' });

    expect(res.status).toBe(201);
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
    expect(insert?.[1]).toContain('song');
    expect(insert?.[1]).toContain(null);
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

describe('POST /api/tracks/upload/finalize metadata', () => {
  const uploadId = '11111111-2222-3333-4444-555555555555';
  const tmpDir = path.join(path.resolve(process.cwd(), 'uploads'), 'tmp', uploadId);
  const tracksDir = path.join(path.resolve(process.cwd(), 'uploads'), 'tracks');

  async function stageChunks(originalName: string) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const payload = Buffer.alloc(10, 7);
    await fs.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify({
      original_name: originalName,
      mime_type: 'audio/mpeg',
      size: payload.length,
      chunk_size: 5 * 1024 * 1024,
      chunk_count: 2,
      created_at: new Date().toISOString(),
    }));
    await fs.writeFile(path.join(tmpDir, '0.part'), payload.subarray(0, 5));
    await fs.writeFile(path.join(tmpDir, '1.part'), payload.subarray(5));
  }

  it('stores the tag title instead of the file name the client had to fall back to', async () => {
    await stageChunks('my song.mp3');
    tagReads.readAudioTags.mockResolvedValue({ title: 'Tagged Title', artist: 'Tagged Artist', album: 'Tagged Album' });

    try {
      const res = await request(app)
        .post('/api/tracks/upload/finalize')
        .set('Cookie', adminCookie())
        .send({ upload_id: uploadId, title: 'my song.mp3', program_id: 'p1' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Tagged Title');
      expect(res.body.artist).toBe('Tagged Artist');
      expect(res.body.album).toBe('Tagged Album');
      expect(tagReads.readAudioTags).toHaveBeenCalledWith(path.join(tracksDir, res.body.file_path));

      const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
      expect(insert?.[1]).toContain('Tagged Title');
      expect(insert?.[1]).toContain('Tagged Artist');
    } finally {
      const stored = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
      const file = (stored?.[1] as unknown[] | undefined)?.[5];
      if (typeof file === 'string') await fs.rm(path.join(tracksDir, file), { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps a title the client typed by hand', async () => {
    await stageChunks('my song.mp3');
    tagReads.readAudioTags.mockResolvedValue({ title: 'Tagged Title', artist: null, album: null });

    try {
      const res = await request(app)
        .post('/api/tracks/upload/finalize')
        .set('Cookie', adminCookie())
        .send({ upload_id: uploadId, title: 'Chosen title', program_id: 'p1' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Chosen title');
      expect(res.body.artist).toBeNull();
    } finally {
      const stored = db.runSQL.mock.calls.find((c) => /INSERT INTO tracks/.test(c[0] as string));
      const file = (stored?.[1] as unknown[] | undefined)?.[5];
      if (typeof file === 'string') await fs.rm(path.join(tracksDir, file), { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/tracks', () => {
  const uploadsRoot = path.resolve(process.cwd(), 'uploads');

  function bulkDelete(trackIds: unknown) {
    return request(app)
      .delete('/api/tracks')
      .set('Cookie', superCookie())
      .send({ trackIds });
  }

  it('refuses an admin who is not a super admin', async () => {
    const res = await request(app)
      .delete('/api/tracks')
      .set('Cookie', adminCookie())
      .send({ trackIds: ['t1'] });

    expect(res.status).toBe(403);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('requires a non-empty trackIds array', async () => {
    for (const body of [{}, { trackIds: [] }, { trackIds: 't1' }]) {
      const res = await request(app)
        .delete('/api/tracks')
        .set('Cookie', superCookie())
        .send(body);

      expect(res.status).toBe(400);
    }
    expect(db.queryAll).not.toHaveBeenCalled();
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects ids that are not strings, which mysql2 cannot bind', async () => {
    const res = await bulkDelete([{ id: 't1' }]);

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('caps the batch so one request cannot hold the connection pool', async () => {
    const res = await bulkDelete(Array.from({ length: 51 }, (_, i) => `t${i}`));

    expect(res.status).toBe(400);
    expect(db.queryAll).not.toHaveBeenCalled();
  });

  it('deletes the tracks that exist, unlinks their files and reports the rest', async () => {
    db.queryAll.mockResolvedValue([
      { id: 't1', file_path: 'one.mp3', program_id: 'p1' },
      { id: 't2', file_path: null, program_id: 'p1' },
      { id: 't3', file_path: 'three.mp3', program_id: 'p2' },
    ]);

    const res = await bulkDelete(['t1', 't2', 't3', 'gone']);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Tracks deleted', deleted: 3, notFound: ['gone'] });
    expect(db.queryAll).toHaveBeenCalledWith(
      'SELECT id, file_path, program_id FROM tracks WHERE id IN (?,?,?,?)',
      ['t1', 't2', 't3', 'gone']
    );
    expect(db.runSQL).toHaveBeenCalledWith(
      'DELETE FROM tracks WHERE id IN (?,?,?,?)',
      ['t1', 't2', 't3', 'gone']
    );
    expect(cacheDelete).toHaveBeenCalledWith(
      ...programReadCacheKeys('p1'),
      ...programReadCacheKeys('p2')
    );
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith(path.join(uploadsRoot, 'tracks', 'one.mp3'));
    expect(unlink).toHaveBeenCalledWith(path.join(uploadsRoot, 'tracks', 'three.mp3'));
  });

  it('reports everything as not found without deleting anything', async () => {
    const res = await bulkDelete(['ghost']);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Tracks deleted', deleted: 0, notFound: ['ghost'] });
    expect(db.runSQL).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});