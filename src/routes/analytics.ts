import { Router, Response } from 'express';
import { queryAll, queryOne } from '../database/schema';
import { AuthRequest, authenticate, requireAdmin } from '../middleware/auth';
import { cacheGet, cacheSet } from '../cache/redis';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

// These are aggregate scans over every row in listens/comments/tracks. Cheap
// for a small catalog, expensive once it isn't, and the dashboard only needs
// it fresh to within a minute.
const CACHE_TTL = 60;

router.get('/', authenticate, requireAdmin, asyncHandler(async (_req: AuthRequest, res: Response) => {
  const cached = await cacheGet('admin:analytics');
  if (cached) return res.json(cached);

  const [
    programsRow, tracksRow, usersRow, commentsRow, likesRow, listensRow, listenersRow,
    programsByUser,
    tracksByType,
    tracksByProgram,
    mostLikedTracks,
    recentComments,
    programsByMonth,
    tracksByMonth,
    listensByMonth,
    listenersByMonth,
    commentsByMonth,
  ] = await Promise.all([
    queryOne('SELECT COUNT(*) as count FROM programs'),
    queryOne('SELECT COUNT(*) as count FROM tracks'),
    queryOne('SELECT COUNT(*) as count FROM users'),
    queryOne('SELECT COUNT(*) as count FROM comments'),
    queryOne('SELECT COUNT(*) as count FROM likes'),
    queryOne('SELECT COUNT(*) as count FROM listens'),
    queryOne('SELECT COUNT(DISTINCT fingerprint) as count FROM listens WHERE fingerprint IS NOT NULL'),
    queryAll(`
      SELECT u.username, COUNT(p.id) as count
      FROM users u
      LEFT JOIN programs p ON u.id = p.created_by
      GROUP BY u.id
      ORDER BY count DESC
    `),
    queryAll(`
      SELECT track_type, COUNT(*) as count
      FROM tracks
      GROUP BY track_type
      ORDER BY count DESC
    `),
    queryAll(`
      SELECT p.title, COUNT(t.id) as count
      FROM programs p
      LEFT JOIN tracks t ON p.id = t.program_id
      GROUP BY p.id
      ORDER BY count DESC
    `),
    queryAll(`
      SELECT t.title, t.artist, COUNT(l.id) as like_count, p.title as program_title
      FROM tracks t
      LEFT JOIN likes l ON t.id = l.track_id
      LEFT JOIN programs p ON t.program_id = p.id
      GROUP BY t.id
      ORDER BY like_count DESC
      LIMIT 10
    `),
    queryAll(`
      SELECT c.*, p.title as program_title
      FROM comments c
      JOIN programs p ON c.program_id = p.id
      ORDER BY c.created_at DESC
      LIMIT 10
    `),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM programs
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM tracks
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM listens
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(DISTINCT fingerprint) as count
      FROM listens
      WHERE fingerprint IS NOT NULL
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
    queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM comments
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `),
  ]);

  const payload = {
    totals: {
      programs: programsRow?.count || 0,
      tracks: tracksRow?.count || 0,
      users: usersRow?.count || 0,
      comments: commentsRow?.count || 0,
      likes: likesRow?.count || 0,
      listens: listensRow?.count || 0,
      listeners: listenersRow?.count || 0,
    },
    programsByUser,
    tracksByType,
    tracksByProgram,
    mostLikedTracks,
    recentComments,
    programsByMonth,
    tracksByMonth,
    listensByMonth,
    listenersByMonth,
    commentsByMonth,
  };

  await cacheSet('admin:analytics', payload, CACHE_TTL);
  res.json(payload);
}));

export default router;
