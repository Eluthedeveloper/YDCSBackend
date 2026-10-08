import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, runSQL } from '../database/schema';
import { cacheGet, cacheSet, cacheDelete } from '../cache/redis';
import { programReadCacheKeys } from '../lib/cacheKeys';
import { interactionLimiter } from '../middleware/rateLimit';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const CACHE_TTL = 300;

interface TrackRef {
  id: string;
  program_id: string;
}

// The client identifier is used for one-like-per-listener and listen dedup. It
// arrives in a header rather than the path so it never lands in nginx access
// logs or browser history.
const CLIENT_ID_HEADER = 'x-client-fingerprint';
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{8,255}$/;

// MySQL's ER_DUP_ENTRY, reused from the unique-key handling on the like toggle.
const ER_DUP_ENTRY = 1062;

/**
 * Window in which repeat plays of one track by one listener count once.
 *
 * The deduplication the header comment promises is this check: without it a
 * single listener replaying a track, or a retrying client, inflates the play
 * counts the analytics dashboard reports. Best-effort — two concurrent requests
 * can both pass it — because the consequence is one extra row in a reporting
 * table, and making it exact would need a bucketed unique key and a migration.
 */
const LISTEN_DEDUP_SECONDS = 30 * 60;

function readFingerprint(req: { get(name: string): string | undefined }, body?: unknown): string | null {
  const candidate = req.get(CLIENT_ID_HEADER) || (body as { fingerprint?: unknown })?.fingerprint;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return FINGERPRINT_RE.test(trimmed) ? trimmed : null;
}

/**
 * Every cached payload that embeds a like or comment count for a program.
 * Invalidating by exact key keeps a like from forcing a full SCAN over the
 * keyspace, and covering every key is what stops the counters from disagreeing
 * between the list view, the detail view and the analytics dashboard.
 */
function programCacheKeys(programId: string): string[] {
  return programReadCacheKeys(programId);
}

router.get('/programs', asyncHandler(async (_req, res: Response) => {
  const cached = await cacheGet('public:programs');
  if (cached) return res.json(cached);

  const programs = await queryAll(`
    SELECT p.*, u.username as creator_name,
      (SELECT COUNT(*) FROM tracks WHERE program_id = p.id) as track_count,
      (SELECT COUNT(*) FROM comments WHERE program_id = p.id) as comment_count,
      (SELECT COUNT(*) FROM likes l JOIN tracks t ON l.track_id = t.id WHERE t.program_id = p.id) as like_count
    FROM programs p
    JOIN users u ON p.created_by = u.id
    ORDER BY p.created_at DESC
  `);

  await cacheSet('public:programs', programs, CACHE_TTL);
  res.json(programs);
}));

router.get('/programs/:id', asyncHandler(async (req, res: Response) => {
  const cacheKey = `public:program:${req.params.id}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const program = await queryOne(`
    SELECT p.*, u.username as creator_name,
      (SELECT COUNT(*) FROM likes l JOIN tracks t ON l.track_id = t.id WHERE t.program_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE program_id = p.id) as comment_count
    FROM programs p
    JOIN users u ON p.created_by = u.id
    WHERE p.id = ?
  `, [req.params.id]);

  if (!program) return res.status(404).json({ error: 'Program not found' });

  const [tracks, comments] = await Promise.all([
    queryAll(`
      SELECT t.*,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as like_count,
        p.cover_image as program_cover
      FROM tracks t
      JOIN programs p ON t.program_id = p.id
      WHERE t.program_id = ?
      ORDER BY t.sort_order ASC, t.created_at ASC
    `, [req.params.id]),
    queryAll(`
      SELECT id, guest_name, content, created_at FROM comments
      WHERE program_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.params.id]),
  ]);

  const result = { ...program, tracks, comments };
  await cacheSet(cacheKey, result, CACHE_TTL);
  res.json(result);
}));

router.get('/latest-tracks', asyncHandler(async (_req, res: Response) => {
  const cached = await cacheGet('public:latest-tracks');
  if (cached) return res.json(cached);

  const tracks = await queryAll(`
    SELECT t.*,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as like_count,
      p.title as program_title, p.cover_image as program_cover
    FROM tracks t
    JOIN programs p ON t.program_id = p.id
    ORDER BY t.created_at DESC
    LIMIT 50
  `);

  await cacheSet('public:latest-tracks', tracks, CACHE_TTL);
  res.json(tracks);
}));

// Search results are deliberately NOT cached. The query string is
// attacker-controlled, so caching it let anyone grow the keyspace (and every
// `public:*` invalidation's cost) without bound, and the result embeds like
// counts that go stale for no reason. The keyspace is now finite, which is what
// makes targeted invalidation above sufficient.
router.get('/search', asyncHandler(async (req, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.json({ programs: [], tracks: [] });
  }

  const like = `%${q}%`;

  const [programs, tracks] = await Promise.all([
    queryAll(`
      SELECT p.*, u.username as creator_name,
        (SELECT COUNT(*) FROM tracks WHERE program_id = p.id) as track_count,
        (SELECT COUNT(*) FROM comments WHERE program_id = p.id) as comment_count
      FROM programs p
      JOIN users u ON p.created_by = u.id
      WHERE p.title LIKE ? OR p.description LIKE ?
      ORDER BY p.created_at DESC
      LIMIT 20
    `, [like, like]),
    queryAll(`
      SELECT t.*,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as like_count,
        p.title as program_title, p.cover_image as program_cover
      FROM tracks t
      JOIN programs p ON t.program_id = p.id
      WHERE t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [like, like, like]),
  ]);

  res.json({ programs, tracks });
}));

router.post('/programs/:id/comments', interactionLimiter, asyncHandler(async (req, res: Response) => {
  const guest_name = typeof req.body?.guest_name === 'string' ? req.body.guest_name.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';

  if (!guest_name || !content) {
    return res.status(400).json({ error: 'Name and content required' });
  }
  // Bound the stored strings so a single guest cannot fill the table; MySQL
  // would otherwise truncate at 255 chars silently.
  if (guest_name.length > 100) {
    return res.status(400).json({ error: 'Name must be 100 characters or fewer' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'Comment must be 5000 characters or fewer' });
  }

  const program = await queryOne('SELECT id FROM programs WHERE id = ?', [req.params.id]);
  if (!program) return res.status(404).json({ error: 'Program not found' });

  const id = uuidv4();
  await runSQL('INSERT INTO comments (id, program_id, guest_name, content) VALUES (?, ?, ?, ?)',
    [id, req.params.id, guest_name, content]);

  // A new comment changes comment_count in the list view too, so both keys
  // have to go or the badge disagrees with the detail page.
  await cacheDelete(...programCacheKeys(req.params.id));

  const comment = await queryOne('SELECT id, guest_name, content, created_at FROM comments WHERE id = ?', [id]);
  res.status(201).json(comment);
}));

router.post('/tracks/:id/like', interactionLimiter, asyncHandler(async (req, res: Response) => {
  const fingerprint = readFingerprint(req);
  if (!fingerprint) return res.status(400).json({ error: 'Valid client fingerprint required' });

  const track = await queryOne<TrackRef>('SELECT id, program_id FROM tracks WHERE id = ?', [req.params.id]);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const existing = await queryOne('SELECT id FROM likes WHERE track_id = ? AND fingerprint = ?',
    [req.params.id, fingerprint]);

  if (existing) {
    await runSQL('DELETE FROM likes WHERE id = ?', [existing.id]);
    await cacheDelete(...programCacheKeys(track.program_id));
    res.json({ liked: false });
    return;
  }

  const id = uuidv4();
  try {
    await runSQL('INSERT INTO likes (id, track_id, fingerprint) VALUES (?, ?, ?)',
      [id, req.params.id, fingerprint]);
  } catch (err) {
    // Check-then-act: two clicks landing together both miss the SELECT above,
    // and `unique_like (track_id, fingerprint)` then rejects the second INSERT.
    // The like did land, so this is the success path, not a failure — reporting
    // it as a 500 left the client showing a heart that never filled.
    if ((err as { errno?: number })?.errno === ER_DUP_ENTRY) {
      await cacheDelete(...programCacheKeys(track.program_id));
      return res.json({ liked: true });
    }
    throw err;
  }
  await cacheDelete(...programCacheKeys(track.program_id));
  res.json({ liked: true });
}));

router.get('/tracks/:id/likes', asyncHandler(async (req, res: Response) => {
  const result = await queryOne('SELECT COUNT(*) as count FROM likes WHERE track_id = ?', [req.params.id]);
  res.json({ count: result?.count || 0 });
}));

router.get('/tracks/:id/liked', asyncHandler(async (req, res: Response) => {
  const fingerprint = readFingerprint(req);
  if (!fingerprint) return res.status(400).json({ error: 'Valid client fingerprint required' });

  const existing = await queryOne('SELECT id FROM likes WHERE track_id = ? AND fingerprint = ?',
    [req.params.id, fingerprint]);
  res.json({ liked: !!existing });
}));

// The fingerprint is required, matching /like and /liked. Accepting a listen
// without one let anyone inflate the play counts that the analytics dashboard
// reports; a listener with no valid id is simply not counted.
router.post('/tracks/:id/listen', interactionLimiter, asyncHandler(async (req, res: Response) => {
  const fingerprint = readFingerprint(req);
  if (!fingerprint) return res.status(400).json({ error: 'Valid client fingerprint required' });

  const track = await queryOne<TrackRef>('SELECT id, program_id FROM tracks WHERE id = ?', [req.params.id]);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const recent = await queryOne(
    `SELECT id FROM listens
     WHERE track_id = ? AND fingerprint = ? AND created_at > (NOW() - INTERVAL ? SECOND)
     LIMIT 1`,
    [track.id, fingerprint, LISTEN_DEDUP_SECONDS]
  );
  if (recent) return res.json({ success: true, counted: false });

  const id = uuidv4();
  await runSQL('INSERT INTO listens (id, track_id, program_id, fingerprint) VALUES (?, ?, ?, ?)',
    [id, track.id, track.program_id, fingerprint]);

  // No cache invalidate here: a listen never changes any cached program/track
  // payload, and flushing the whole cache on every play would defeat caching
  // under streaming load. The listens stats key self-expires in 60s.
  res.json({ success: true, counted: true });
}));

router.get('/listens/stats', asyncHandler(async (_req, res: Response) => {
  const cached = await cacheGet('public:listens:stats');
  if (cached) return res.json(cached);

  const [totalRow, listensByMonth, listensByProgram, mostListenedTracks] = await Promise.all([
    queryOne('SELECT COUNT(*) as count FROM listens'),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM listens
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
    queryAll(`
      SELECT p.title, COUNT(l.id) as count
      FROM listens l
      JOIN programs p ON l.program_id = p.id
      GROUP BY l.program_id
      ORDER BY count DESC
      LIMIT 10
    `),
    queryAll(`
      SELECT t.title, t.artist, COUNT(l.id) as listen_count, p.title as program_title
      FROM listens l
      JOIN tracks t ON l.track_id = t.id
      JOIN programs p ON l.program_id = p.id
      GROUP BY l.track_id
      ORDER BY listen_count DESC
      LIMIT 10
    `),
  ]);

  const result = {
    totalListens: totalRow?.count || 0,
    listensByMonth,
    listensByProgram,
    mostListenedTracks,
  };
  await cacheSet('public:listens:stats', result, 60);
  res.json(result);
}));

export default router;
