import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { queryAll, queryOne, runSQL } from '../database/schema';
import { cacheGet, cacheSet, cacheInvalidate } from '../cache/redis';

const router = Router();

const CACHE_TTL = 300;

const interactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many actions, please try again later.' },
});

router.get('/programs', async (_req, res: Response) => {
  try {
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
  } catch (err) {
    console.error('Error fetching public programs:', err);
    res.status(500).json({ error: 'Failed to fetch programs' });
  }
});

router.get('/programs/:id', async (req, res: Response) => {
  try {
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

    const tracks = await queryAll(`
      SELECT t.*,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as like_count,
        p.cover_image as program_cover
      FROM tracks t
      JOIN programs p ON t.program_id = p.id
      WHERE t.program_id = ?
      ORDER BY t.sort_order ASC, t.created_at ASC
    `, [req.params.id]);

    const comments = await queryAll(`
      SELECT id, guest_name, content, created_at FROM comments
      WHERE program_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.params.id]);

    const result = { ...program, tracks, comments };
    await cacheSet(cacheKey, result, CACHE_TTL);
    res.json(result);
  } catch (err) {
    console.error('Error fetching public program:', err);
    res.status(500).json({ error: 'Failed to fetch program' });
  }
});

router.get('/latest-tracks', async (_req, res: Response) => {
  try {
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
  } catch (err) {
    console.error('Error fetching latest tracks:', err);
    res.status(500).json({ error: 'Failed to fetch latest tracks' });
  }
});

router.get('/search', async (req, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      return res.json({ programs: [], tracks: [] });
    }

    // Cap the key so attackers can't use arbitrary query strings to fill Redis.
    const cacheKey = `public:search:${q.toLowerCase().trim().slice(0, 100)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const like = `%${q}%`;

    const programs = await queryAll(`
      SELECT p.*, u.username as creator_name,
        (SELECT COUNT(*) FROM tracks WHERE program_id = p.id) as track_count,
        (SELECT COUNT(*) FROM comments WHERE program_id = p.id) as comment_count
      FROM programs p
      JOIN users u ON p.created_by = u.id
      WHERE p.title LIKE ? OR p.description LIKE ?
      ORDER BY p.created_at DESC
      LIMIT 20
    `, [like, like]);

    const tracks = await queryAll(`
      SELECT t.*,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as like_count,
        p.title as program_title, p.cover_image as program_cover
      FROM tracks t
      JOIN programs p ON t.program_id = p.id
      WHERE t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [like, like, like]);

    const result = { programs, tracks };
    await cacheSet(cacheKey, result, 120);
    res.json(result);
  } catch (err) {
    console.error('Error searching:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.post('/programs/:id/comments', interactionLimiter, async (req, res: Response) => {
  try {
    const { guest_name, content } = req.body;
    if (!guest_name || !content) {
      return res.status(400).json({ error: 'Name and content required' });
    }

    const program = await queryOne('SELECT id FROM programs WHERE id = ?', [req.params.id]);
    if (!program) return res.status(404).json({ error: 'Program not found' });

    const id = uuidv4();
    await runSQL('INSERT INTO comments (id, program_id, guest_name, content) VALUES (?, ?, ?, ?)',
      [id, req.params.id, guest_name, content]);

    await cacheInvalidate(`public:program:${req.params.id}`);

    const comment = await queryOne('SELECT * FROM comments WHERE id = ?', [id]);
    res.json(comment);
  } catch (err) {
    console.error('Error posting comment:', err);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

router.post('/tracks/:id/like', interactionLimiter, async (req, res: Response) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) return res.status(400).json({ error: 'Fingerprint required' });

    const track = await queryOne('SELECT id, program_id FROM tracks WHERE id = ?', [req.params.id]) as any;
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const existing = await queryOne('SELECT id FROM likes WHERE track_id = ? AND fingerprint = ?',
      [req.params.id, fingerprint]);

    if (existing) {
      await runSQL('DELETE FROM likes WHERE id = ?', [existing.id]);
      await cacheInvalidate('public:*');
      res.json({ liked: false });
    } else {
      const id = uuidv4();
      await runSQL('INSERT INTO likes (id, track_id, fingerprint) VALUES (?, ?, ?)',
        [id, req.params.id, fingerprint]);
      await cacheInvalidate('public:*');
      res.json({ liked: true });
    }
  } catch (err) {
    console.error('Error toggling like:', err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

router.get('/tracks/:id/likes', async (req, res: Response) => {
  try {
    const result = await queryOne('SELECT COUNT(*) as count FROM likes WHERE track_id = ?', [req.params.id]);
    res.json({ count: result?.count || 0 });
  } catch (err) {
    console.error('Error fetching likes:', err);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
});

router.get('/tracks/:id/liked/:fingerprint', async (req, res: Response) => {
  try {
    const existing = await queryOne('SELECT id FROM likes WHERE track_id = ? AND fingerprint = ?',
      [req.params.id, req.params.fingerprint]);
    res.json({ liked: !!existing });
  } catch (err) {
    console.error('Error checking like status:', err);
    res.status(500).json({ error: 'Failed to check like status' });
  }
});

router.post('/tracks/:id/listen', interactionLimiter, async (req, res: Response) => {
  try {
    const { fingerprint } = req.body;
    const track = await queryOne('SELECT id, program_id FROM tracks WHERE id = ?', [req.params.id]) as any;
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const id = uuidv4();
    await runSQL('INSERT INTO listens (id, track_id, program_id, fingerprint) VALUES (?, ?, ?, ?)',
      [id, track.id, track.program_id, fingerprint || null]);

    // No cache invalidate here: a listen never changes any cached program/track
    // payload, and flushing the whole cache on every play would defeat caching
    // under streaming load. The listens stats key self-expires in 60s.
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording listen:', err);
    res.status(500).json({ error: 'Failed to record listen' });
  }
});

router.get('/listens/stats', async (_req, res: Response) => {
  try {
    const cached = await cacheGet('public:listens:stats');
    if (cached) return res.json(cached);

    const totalListens = (await queryOne('SELECT COUNT(*) as count FROM listens'))?.count || 0;

    const listensByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM listens
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const listensByProgram = await queryAll(`
      SELECT p.title, COUNT(l.id) as count
      FROM listens l
      JOIN programs p ON l.program_id = p.id
      GROUP BY l.program_id
      ORDER BY count DESC
      LIMIT 10
    `);

    const mostListenedTracks = await queryAll(`
      SELECT t.title, t.artist, COUNT(l.id) as listen_count, p.title as program_title
      FROM listens l
      JOIN tracks t ON l.track_id = t.id
      JOIN programs p ON l.program_id = p.id
      GROUP BY l.track_id
      ORDER BY listen_count DESC
      LIMIT 10
    `);

    const result = { totalListens, listensByMonth, listensByProgram, mostListenedTracks };
    await cacheSet('public:listens:stats', result, 60);
    res.json(result);
  } catch (err) {
    console.error('Error fetching listen stats:', err);
    res.status(500).json({ error: 'Failed to fetch listen stats' });
  }
});

export default router;
