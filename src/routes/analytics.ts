import { Router, Response } from 'express';
import { queryAll, queryOne } from '../database/schema';
import { AuthRequest, authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const totalPrograms = (await queryOne('SELECT COUNT(*) as count FROM programs'))?.count || 0;
    const totalTracks = (await queryOne('SELECT COUNT(*) as count FROM tracks'))?.count || 0;
    const totalUsers = (await queryOne('SELECT COUNT(*) as count FROM users'))?.count || 0;
    const totalComments = (await queryOne('SELECT COUNT(*) as count FROM comments'))?.count || 0;
    const totalLikes = (await queryOne('SELECT COUNT(*) as count FROM likes'))?.count || 0;

    const programsByUser = await queryAll(`
      SELECT u.username, COUNT(p.id) as count
      FROM users u
      LEFT JOIN programs p ON u.id = p.created_by
      GROUP BY u.id
      ORDER BY count DESC
    `);

    const tracksByType = await queryAll(`
      SELECT track_type, COUNT(*) as count
      FROM tracks
      GROUP BY track_type
      ORDER BY count DESC
    `);

    const tracksByProgram = await queryAll(`
      SELECT p.title, COUNT(t.id) as count
      FROM programs p
      LEFT JOIN tracks t ON p.id = t.program_id
      GROUP BY p.id
      ORDER BY count DESC
    `);

    const mostLikedTracks = await queryAll(`
      SELECT t.title, t.artist, COUNT(l.id) as like_count, p.title as program_title
      FROM tracks t
      LEFT JOIN likes l ON t.id = l.track_id
      LEFT JOIN programs p ON t.program_id = p.id
      GROUP BY t.id
      ORDER BY like_count DESC
      LIMIT 10
    `);

    const recentComments = await queryAll(`
      SELECT c.*, p.title as program_title
      FROM comments c
      JOIN programs p ON c.program_id = p.id
      ORDER BY c.created_at DESC
      LIMIT 10
    `);

    const programsByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM programs
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const tracksByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM tracks
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const totalListens = (await queryOne('SELECT COUNT(*) as count FROM listens'))?.count || 0;
    const totalListeners = (await queryOne('SELECT COUNT(DISTINCT fingerprint) as count FROM listens WHERE fingerprint IS NOT NULL'))?.count || 0;

    const listensByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM listens
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const listenersByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(DISTINCT fingerprint) as count
      FROM listens
      WHERE fingerprint IS NOT NULL
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const commentsByMonth = await queryAll(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
      FROM comments
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    res.json({
      totals: { programs: totalPrograms, tracks: totalTracks, users: totalUsers, comments: totalComments, likes: totalLikes, listens: totalListens, listeners: totalListeners },
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
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

export default router;
