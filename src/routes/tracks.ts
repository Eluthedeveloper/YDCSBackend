import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import rateLimit from 'express-rate-limit';
import { queryAll, queryOne, runSQL, getPool } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { cacheInvalidate } from '../cache/redis';
import { sanitizeBody } from '../lib/sanitize';

const router = Router();

const TRACK_TYPES = ['episode', 'single', 'mix', 'live'] as const;

// Best-effort deletion of a file that was already written by multer but the
// request then failed during validation/DB work, so orphaned files don't
// accumulate in uploads/tracks.
function cleanupUploadedFile(file?: Express.Multer.File | null) {
  if (file?.filename) {
    fs.unlink(path.join('uploads', 'tracks', file.filename)).catch(() => {});
  }
}

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Write limit reached, try again later.' },
});

const trackStorage = multer.diskStorage({
  destination: './uploads/tracks',
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const uploadTrack = multer({
  storage: trackStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /mp3|wav|ogg|flac|m4a|aac/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/mp4');
    if (!extOk || !mimeOk) return cb(new Error('Invalid file type'));
    cb(null, true);
  }
});

router.get('/program/:programId', authenticate, requireAdmin, async (req, res: Response) => {
  try {
    const tracks = await queryAll(`
      SELECT t.*, u.username as creator_name, p.cover_image as program_cover
      FROM tracks t
      JOIN users u ON t.created_by = u.id
      JOIN programs p ON t.program_id = p.id
      WHERE t.program_id = ?
      ORDER BY t.sort_order ASC, t.created_at ASC
    `, [req.params.programId]);
    res.json(tracks);
  } catch (err) {
    console.error('Error fetching tracks:', err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

router.post('/', writeLimiter, authenticate, requireAdmin, uploadTrack.single('audio_file'), sanitizeBody, async (req: AuthRequest, res: Response) => {
  try {
    const { title, artist, album, program_id, track_type, duration } = req.body;

    if (!title || !title.trim()) {
      cleanupUploadedFile(req.file);
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!program_id) {
      cleanupUploadedFile(req.file);
      return res.status(400).json({ error: 'Program ID is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file required' });
    }
    if (track_type && !TRACK_TYPES.includes(track_type)) {
      cleanupUploadedFile(req.file);
      return res.status(400).json({ error: 'Invalid track type' });
    }
    if (duration !== undefined && (typeof duration !== 'number' || isNaN(duration) || duration < 0)) {
      cleanupUploadedFile(req.file);
      return res.status(400).json({ error: 'Invalid duration' });
    }

    const program = await queryOne('SELECT * FROM programs WHERE id = ?', [program_id]) as any;
    if (!program) {
      cleanupUploadedFile(req.file);
      return res.status(404).json({ error: 'Program not found' });
    }

    const existingCount = await queryOne('SELECT COUNT(*) as count FROM tracks WHERE program_id = ?', [program_id]) as any;
    const sortOrder = existingCount?.count || 0;

    const id = uuidv4();
    await runSQL(
      'INSERT INTO tracks (id, title, artist, album, duration, file_path, program_id, track_type, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title.trim(), artist || null, album || null, duration || 0, req.file.filename, program_id, track_type || 'episode', sortOrder, req.user!.id]
    );

    await cacheInvalidate('public:*');
    res.json({ id, title: title.trim(), artist, album, file_path: req.file.filename, program_id, track_type, sort_order: sortOrder });
  } catch (err) {
    cleanupUploadedFile(req.file);
    console.error('Error creating track:', err);
    res.status(500).json({ error: 'Failed to create track' });
  }
});

router.post('/bulk', writeLimiter, authenticate, requireAdmin, uploadTrack.array('audio_files', 50), sanitizeBody, async (req: AuthRequest, res: Response) => {
  let files: Express.Multer.File[] | undefined;
  try {
    const { program_id, track_type } = req.body;
    // Per-file metadata sent as parallel repeated fields (multer turns repeated
    // form fields into arrays). Falls back to the filename for the title.
    const titles = Array.isArray(req.body.titles) ? req.body.titles : [];
    const artists = Array.isArray(req.body.artists) ? req.body.artists : [];
    const albums = Array.isArray(req.body.albums) ? req.body.albums : [];

    if (!program_id) {
      return res.status(400).json({ error: 'Program ID is required' });
    }
    if (track_type && !TRACK_TYPES.includes(track_type)) {
      return res.status(400).json({ error: 'Invalid track type' });
    }

    const program = await queryOne('SELECT * FROM programs WHERE id = ?', [program_id]) as any;
    if (!program) return res.status(404).json({ error: 'Program not found' });

    files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No audio files provided' });
    }

    const existingCount = await queryOne('SELECT COUNT(*) as count FROM tracks WHERE program_id = ?', [program_id]) as any;
    let sortOrder = existingCount?.count || 0;

    const pool = getPool();
    const conn = await pool.getConnection();
    const uploaded: any[] = [];
    try {
      await conn.beginTransaction();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const id = uuidv4();
        const trackTitle = (titles[i] ? String(titles[i]).trim() : '') || file.originalname.replace(/\.[^.]+$/, '');
        const artist = artists[i] ? String(artists[i]).trim() || null : null;
        const album = albums[i] ? String(albums[i]).trim() || null : null;
        await conn.execute(
          'INSERT INTO tracks (id, title, artist, album, duration, file_path, program_id, track_type, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, trackTitle, artist, album, 0, file.filename, program_id, track_type || 'episode', sortOrder, req.user!.id]
        );
        uploaded.push({ id, title: trackTitle, file_path: file.filename, sort_order: sortOrder });
        sortOrder++;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      // The transaction failed, so the already-written files are orphaned.
      for (const file of files) cleanupUploadedFile(file);
      throw e;
    } finally {
      conn.release();
    }

    await cacheInvalidate('public:*');
    res.json({ uploaded: uploaded.length, tracks: uploaded });
  } catch (err) {
    console.error('Error bulk uploading tracks:', err);
    res.status(500).json({ error: 'Failed to upload tracks' });
  }
});

router.put('/:id', writeLimiter, authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const track = await queryOne('SELECT * FROM tracks WHERE id = ?', [req.params.id]) as any;
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const { title, artist, album, track_type, duration } = req.body;

    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return res.status(400).json({ error: 'Invalid title' });
    }
    if (track_type && !TRACK_TYPES.includes(track_type)) {
      return res.status(400).json({ error: 'Invalid track type' });
    }
    if (duration !== undefined && (typeof duration !== 'number' || isNaN(duration) || duration < 0)) {
      return res.status(400).json({ error: 'Invalid duration' });
    }

    // Optional fields can be explicitly cleared to null by sending an empty
    // string; absent fields keep their current value.
    const updatedTitle = title !== undefined && title.trim() ? title.trim() : track.title;
    const updatedArtist = artist !== undefined ? (artist || null) : track.artist;
    const updatedAlbum = album !== undefined ? (album || null) : track.album;
    const updatedType = track_type || track.track_type;
    const updatedDuration = duration !== undefined && !isNaN(duration) ? duration : track.duration;

    await runSQL('UPDATE tracks SET title = ?, artist = ?, album = ?, track_type = ?, duration = ? WHERE id = ?',
      [updatedTitle, updatedArtist, updatedAlbum, updatedType, updatedDuration, req.params.id]);

    await cacheInvalidate('public:*');
    res.json({ message: 'Track updated' });
  } catch (err) {
    console.error('Error updating track:', err);
    res.status(500).json({ error: 'Failed to update track' });
  }
});

router.put('/reorder/:programId', writeLimiter, authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { trackIds } = req.body;
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds array required' });
    }

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let index = 0; index < trackIds.length; index++) {
        await conn.execute('UPDATE tracks SET sort_order = ? WHERE id = ? AND program_id = ?',
          [index, trackIds[index], req.params.programId]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    await cacheInvalidate('public:*');
    res.json({ message: 'Order updated' });
  } catch (err) {
    console.error('Error reordering tracks:', err);
    res.status(500).json({ error: 'Failed to reorder tracks' });
  }
});

router.delete('/:id', writeLimiter, authenticate, requireSuperAdmin, async (req, res: Response) => {
  try {
    const track = await queryOne('SELECT file_path FROM tracks WHERE id = ?', [req.params.id]) as any;
    await runSQL('DELETE FROM tracks WHERE id = ?', [req.params.id]);
    await cacheInvalidate('public:*');

    if (track?.file_path) {
      fs.unlink(path.join('uploads', 'tracks', track.file_path)).catch(() => {});
    }

    res.json({ message: 'Track deleted' });
  } catch (err) {
    console.error('Error deleting track:', err);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

export default router;
