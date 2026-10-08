import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

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

const FINGERPRINT = 'fp_abcdef0123456789';
let app: ReturnType<typeof createApp>['app'];

beforeEach(() => {
  vi.clearAllMocks();
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue(undefined);
  cache.del.mockResolvedValue(undefined);
  cache.invalidate.mockResolvedValue(undefined);
  db.queryOne.mockResolvedValue(undefined);
  db.queryAll.mockResolvedValue([]);
  db.runSQL.mockResolvedValue(undefined);
  ({ app } = createApp());
});

describe('POST /api/public/programs/:id/comments', () => {
  it('requires a name and content', async () => {
    const res = await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: 'Abebe' });

    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only name', async () => {
    const res = await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: '   ', content: 'Nice show' });

    expect(res.status).toBe(400);
  });

  // guest_name is VARCHAR(255); without an explicit cap MySQL truncates in
  // strict mode or errors, and either way the stored value is not what was sent.
  it('rejects a name longer than the column allows', async () => {
    const res = await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: 'x'.repeat(300), content: 'Nice show' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100 characters/);
  });

  it('rejects an over-long comment instead of letting the DB truncate it', async () => {
    const res = await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: 'Abebe', content: 'x'.repeat(6000) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5000 characters/);
  });

  it('404s for a program that does not exist', async () => {
    db.queryOne.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/public/programs/ghost/comments')
      .send({ guest_name: 'Abebe', content: 'Nice show' });

    expect(res.status).toBe(404);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('stores the guest text verbatim, without HTML entity mangling', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce({ id: 'c1', guest_name: 'Tom & Jerry', content: '<3 & "quotes"' });

    const res = await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: 'Tom & Jerry', content: '<3 & "quotes"' });

    expect(res.status).toBe(201);

    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO comments/.test(c[0] as string));
    // [generated_uuid, program_id, guest_name, content]
    expect(insert?.[1].slice(1)).toEqual(['p1', 'Tom & Jerry', '<3 & "quotes"']);
    expect(res.body.content).toBe('<3 & "quotes"');
  });

  // comment_count lives in the list view too, so clearing only the detail key
  // left the two views disagreeing for the length of the cache TTL. The
  // analytics dashboard embeds the same counts and used to be missed entirely,
  // leaving it stale until its own 60s TTL expired.
  it('invalidates every cache entry that embeds the comment count', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'p1' }).mockResolvedValueOnce({ id: 'c1' });

    await request(app)
      .post('/api/public/programs/p1/comments')
      .send({ guest_name: 'Abebe', content: 'Nice show' });

    expect(cache.del).toHaveBeenCalledWith(
      'public:programs',
      'public:latest-tracks',
      'public:listens:stats',
      'admin:analytics',
      'public:program:p1'
    );
  });
});

describe('POST /api/public/tracks/:id/like', () => {
  /** First lookup is the track, the second is "does this listener already like it". */
  function givenLike(existing: { id: string } | undefined) {
    db.queryOne.mockReset();
    db.queryOne
      .mockResolvedValueOnce({ id: 't1', program_id: 'p1' })
      .mockResolvedValueOnce(existing);
  }

  it('requires a fingerprint', async () => {
    const res = await request(app).post('/api/public/tracks/t1/like').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a fingerprint with unexpected characters', async () => {
    const res = await request(app)
      .post('/api/public/tracks/t1/like')
      .set('x-client-fingerprint', "'; DROP TABLE likes; --");

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('accepts the fingerprint from a header so it stays out of logs and URLs', async () => {
    givenLike(undefined);

    const res = await request(app)
      .post('/api/public/tracks/t1/like')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: true });
  });

  it('removes the like when one already exists', async () => {
    givenLike({ id: 'like1' });

    const res = await request(app)
      .post('/api/public/tracks/t1/like')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.body).toEqual({ liked: false });
    expect(db.runSQL).toHaveBeenCalledWith('DELETE FROM likes WHERE id = ?', ['like1']);
  });

  it('invalidates only the affected program keys, not the whole keyspace', async () => {
    givenLike(undefined);

    await request(app)
      .post('/api/public/tracks/t1/like')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(cache.del).toHaveBeenCalledWith(
      'public:programs',
      'public:latest-tracks',
      'public:listens:stats',
      'admin:analytics',
      'public:program:p1'
    );
    // A SCAN over `public:*` on a user-triggered path is what this replaced.
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('404s for a track that does not exist', async () => {
    db.queryOne.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/public/tracks/ghost/like')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/public/tracks/:id/liked', () => {
  it('reads the fingerprint from the header, not the path', async () => {
    db.queryOne.mockResolvedValueOnce({ id: 'like1' });

    const res = await request(app)
      .get('/api/public/tracks/t1/liked')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: true });
  });

  it('rejects a missing fingerprint rather than reporting everyone as not-liked', async () => {
    const res = await request(app).get('/api/public/tracks/t1/liked');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/public/tracks/:id/listen', () => {
  // A listen with no fingerprint was still recorded, so anyone could inflate
  // the play counts the analytics dashboard reports.
  it('requires a fingerprint', async () => {
    db.queryOne.mockResolvedValue({ id: 't1', program_id: 'p1' });

    const res = await request(app).post('/api/public/tracks/t1/listen').send({});

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('rejects a malformed fingerprint', async () => {
    db.queryOne.mockResolvedValue({ id: 't1', program_id: 'p1' });

    const res = await request(app)
      .post('/api/public/tracks/t1/listen')
      .set('x-client-fingerprint', 'has spaces');

    expect(res.status).toBe(400);
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('records the listen when the fingerprint is present', async () => {
    // First lookup is the track, the second is the dedup check finding nothing.
    db.queryOne
      .mockResolvedValueOnce({ id: 't1', program_id: 'p1' })
      .mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post('/api/public/tracks/t1/listen')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, counted: true });
    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO listens/.test(c[0] as string));
    expect(insert?.[1]?.slice(1)).toEqual(['t1', 'p1', FINGERPRINT]);
  });

  // The header comment promised listen dedup that did not exist: every replay
  // inserted another row and inflated the play counts analytics reports.
  it('does not record a second listen from the same listener inside the window', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 't1', program_id: 'p1' })
      .mockResolvedValueOnce({ id: 'prior-listen' });

    const res = await request(app)
      .post('/api/public/tracks/t1/listen')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, counted: false });
    expect(db.runSQL).not.toHaveBeenCalled();
  });

  it('still counts a different listener on the same track', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 't1', program_id: 'p1' })
      .mockResolvedValueOnce(undefined);

    await request(app)
      .post('/api/public/tracks/t1/listen')
      .set('x-client-fingerprint', 'fp_someone_else_0001');

    const insert = db.runSQL.mock.calls.find((c) => /INSERT INTO listens/.test(c[0] as string));
    expect(insert?.[1]?.slice(1)).toEqual(['t1', 'p1', 'fp_someone_else_0001']);
  });

  it('404s for a track that does not exist', async () => {
    db.queryOne.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/public/tracks/ghost/listen')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(res.status).toBe(404);
  });

  // A listen changes no cached payload, so flushing the cache here would
  // defeat caching under exactly the streaming load it exists to absorb.
  it('does not invalidate the cache', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 't1', program_id: 'p1' })
      .mockResolvedValueOnce(undefined);

    await request(app)
      .post('/api/public/tracks/t1/listen')
      .set('x-client-fingerprint', FINGERPRINT);

    expect(cache.del).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});

describe('GET /api/public/search', () => {
  // Caching by attacker-supplied query string let anyone grow the Redis
  // keyspace without bound, which also inflated the cost of every
  // `public:*` invalidation.
  it('does not read or write the cache', async () => {
    await request(app).get('/api/public/search?q=prayer');

    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns empty results for a blank query without hitting the database', async () => {
    const res = await request(app).get('/api/public/search?q=%20%20');

    expect(res.body).toEqual({ programs: [], tracks: [] });
    expect(db.queryAll).not.toHaveBeenCalled();
  });

  it('returns empty results when q is absent entirely', async () => {
    const res = await request(app).get('/api/public/search');
    expect(res.body).toEqual({ programs: [], tracks: [] });
  });

  it('passes the term as a bound parameter, not string-concatenated SQL', async () => {
    db.queryAll.mockResolvedValue([]);
    await request(app).get("/api/public/search?q=' OR 1=1 --");

    const calls = db.queryAll.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).not.toContain('OR 1=1');
      // Every placeholder is bound to the same escaped wildcard, never inlined.
      for (const param of call[1]) {
        expect(param).toBe("%' OR 1=1 --%");
      }
    }
  });
});

describe('GET /api/public/programs (cache read)', () => {
  it('serves the cached payload without querying the database', async () => {
    cache.get.mockResolvedValueOnce([{ id: 'p1', title: 'Cached' }]);

    const res = await request(app).get('/api/public/programs');

    expect(res.body).toEqual([{ id: 'p1', title: 'Cached' }]);
    expect(db.queryAll).not.toHaveBeenCalled();
  });
});
