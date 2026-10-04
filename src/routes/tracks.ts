import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { queryAll, queryOne, runSQL, getPool } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimit';
import { cacheInvalidate } from '../cache/redis';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const TRACK_TYPES = ['episode', 'single', 'mix', 'live'] as const;
const MAX_BULK_FILES = 50;

// Mirrors the VARCHAR(255) column widths. Without this, MySQL in strict mode
// rejects the statement outright and the request fails as an opaque 500 rather
// than a message naming the offending field.
const MAX_TITLE = 255;
const MAX_ARTIST = 255;
const MAX_ALBUM = 255;

interface TrackRow {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number;
  track_type: string;
  file_path: string;
  program_id: string;
}

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

// Best-effort deletion of files multer already wrote to disk. Used on every
// path where a request fails after the bytes landed, so failed uploads don't
// accumulate in uploads/tracks.
function cleanupFiles(files?: Array<Express.Multer.File | undefined | null> | null) {
  for (const file of files ?? []) {
    if (file?.filename) {
      fs.unlink(path.join(UPLOADS_ROOT, 'tracks', file.filename)).catch(() => {});
    }
  }
}

const trackStorage = multer.diskStorage({
  destination: './uploads/tracks',
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const uploadTrack = multer({
  storage: trackStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: MAX_BULK_FILES },
  fileFilter: (_req, file, cb) => {
    // Anchored against the full extension so `evil.mp3.html` can't pass on a
    // substring match, and the client-supplied mimetype must agree.
    const ext = path.extname(file.originalname).toLowerCase();
    const extOk = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(ext);
    const mimeOk = file.mimetype.startsWith('audio/') || file.mimetype === 'video/mp4';
    if (!extOk || !mimeOk) return cb(new Error('Invalid file type'));
    cb(null, true);
  }
});

router.get('/program/:programId', authenticate, requireAdmin, asyncHandler(async (req, res: Response) => {
  const tracks = await queryAll(`
    SELECT t.*, u.username as creator_name, p.cover_image as program_cover
    FROM tracks t
    JOIN users u ON t.created_by = u.id
    JOIN programs p ON t.program_id = p.id
    WHERE t.program_id = ?
    ORDER BY t.sort_order ASC, t.created_at ASC
  `, [req.params.programId]);
  res.json(tracks);
}));

router.post('/', writeLimiter, authenticate, requireAdmin, uploadTrack.single('audio_file'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, artist, album, program_id, track_type, duration } = req.body ?? {};

  // Every branch below has to release req.file, so validation failures are
  // funnelled through this one helper rather than repeating cleanupFiles.
  const invalid = (error: string, status = 400) => {
    cleanupFiles([req.file]);
    return res.status(status).json({ error });
  };

  if (!title || !title.trim()) {
    return invalid('Title is required');
  }
  if (String(title).trim().length > MAX_TITLE) {
    return invalid(`Title must be ${MAX_TITLE} characters or fewer`);
  }
  for (const [label, value, max] of [['Artist', artist, MAX_ARTIST], ['Album', album, MAX_ALBUM]] as const) {
    if (typeof value === 'string' && value.length > max) {
      return invalid(`${label} must be ${max} characters or fewer`);
    }
  }
  if (!program_id) {
    return invalid('Program ID is required');
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Audio file required' });
  }
  if (track_type && !TRACK_TYPES.includes(track_type)) {
    return invalid('Invalid track type');
  }
  if (duration !== undefined && (typeof duration !== 'number' || isNaN(duration) || duration < 0)) {
    return invalid('Invalid duration');
  }

  const program = await queryOne('SELECT id FROM programs WHERE id = ?', [program_id]);
  if (!program) {
    // A missing parent is a 404, not a bad request: keep the status the caller
    // saw before validation was factored into the helper.
    return invalid('Program not found', 404);
  }

  const existingCount = await queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM tracks WHERE program_id = ?',
    [program_id]
  );
  const sortOrder = Number(existingCount?.count ?? 0);

  const id = uuidv4();
  await runSQL(
    'INSERT INTO tracks (id, title, artist, album, duration, file_path, program_id, track_type, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, title.trim(), artist || null, album || null, duration || 0, req.file.filename, program_id, track_type || 'episode', sortOrder, req.user!.id]
  );

  await cacheInvalidate('public:*');
  res.status(201).json({ id, title: title.trim(), artist, album, file_path: req.file.filename, program_id, track_type, sort_order: sortOrder });
}));

router.post('/bulk', writeLimiter, authenticate, requireAdmin, uploadTrack.array('audio_files', MAX_BULK_FILES), asyncHandler(async (req: AuthRequest, res: Response) => {
  // Captured immediately: multer has already written every file to disk by the
  // time the handler runs, so every early return below must delete them or the
  // rejected upload leaks up to 50 x 100MB.
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const reject = (status: number, error: string) => {
    cleanupFiles(files);
    return res.status(status).json({ error });
  };

  try {
    const { program_id, track_type } = req.body ?? {};
    // Per-file metadata sent as parallel repeated fields (multer turns repeated
    // form fields into arrays). Falls back to the filename for the title.
    const titles = Array.isArray(req.body?.titles) ? req.body.titles : [];
    const artists = Array.isArray(req.body?.artists) ? req.body.artists : [];
    const albums = Array.isArray(req.body?.albums) ? req.body.albums : [];

    if (!program_id) return reject(400, 'Program ID is required');
    if (track_type && !TRACK_TYPES.includes(track_type)) return reject(400, 'Invalid track type');
    if (files.length === 0) return reject(400, 'No audio files provided');

    // Checked before the insert loop so a batch is rejected as a whole rather
    // than committed with some rows silently truncated by MySQL.
    const tooLong = [
      ...(Array.isArray(titles) ? titles : []).map((t: unknown, i: number) => ['Title', t, MAX_TITLE, i] as const),
      ...(Array.isArray(artists) ? artists : []).map((a: unknown, i: number) => ['Artist', a, MAX_ARTIST, i] as const),
      ...(Array.isArray(albums) ? albums : []).map((a: unknown, i: number) => ['Album', a, MAX_ALBUM, i] as const),
    ].find(([, value, max]) => typeof value === 'string' && value.trim().length > max);
    if (tooLong) {
      const [label, , max, index] = tooLong;
      return reject(400, `${label} ${index + 1} must be ${max} characters or fewer`);
    }

    const program = await queryOne('SELECT id FROM programs WHERE id = ?', [program_id]);
    if (!program) return reject(404, 'Program not found');

    const existingCount = await queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM tracks WHERE program_id = ?',
      [program_id]
    );
    let sortOrder = Number(existingCount?.count ?? 0);

    const pool = getPool();
    const conn = await pool.getConnection();
    const uploaded: Array<{ id: string; title: string; file_path: string; sort_order: number }> = [];
    try {
      await conn.beginTransaction();
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
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
      cleanupFiles(files);
      throw e;
    } finally {
      conn.release();
    }

    await cacheInvalidate('public:*');
    res.status(201).json({ uploaded: uploaded.length, tracks: uploaded });
  } catch (err) {
    // Any error thrown after cleanupFiles already ran is a no-op unlink.
    cleanupFiles(files);
    console.error('Error bulk uploading tracks:', err);
    res.status(500).json({ error: 'Failed to upload tracks' });
  }
}));

router.put('/:id', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const track = await queryOne<TrackRow>('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  const { title, artist, album, track_type, duration } = req.body ?? {};

  if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
    return res.status(400).json({ error: 'Invalid title' });
  }
  if (typeof title === 'string' && title.trim().length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  for (const [label, value, max] of [['Artist', artist, MAX_ARTIST], ['Album', album, MAX_ALBUM]] as const) {
    if (typeof value === 'string' && value.length > max) {
      return res.status(400).json({ error: `${label} must be ${max} characters or fewer` });
    }
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
}));

router.put('/reorder/:programId', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { trackIds } = req.body ?? {};
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
}));

router.delete('/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const track = await queryOne<{ file_path: string | null }>(
    'SELECT file_path FROM tracks WHERE id = ?',
    [req.params.id]
  );
  if (!track) return res.status(404).json({ error: 'Track not found' });

  await runSQL('DELETE FROM tracks WHERE id = ?', [req.params.id]);
  await cacheInvalidate('public:*');

  if (track.file_path) {
    fs.unlink(path.join(UPLOADS_ROOT, 'tracks', track.file_path)).catch(() => {});
  }

  res.json({ message: 'Track deleted' });
}));

export default router;
