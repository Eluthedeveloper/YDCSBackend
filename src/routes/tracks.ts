import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import type mysql from 'mysql2/promise';
import { queryAll, queryOne, runSQL, getPool, withTransaction } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimit';
import { cacheDelete } from '../cache/redis';
import { programReadCacheKeys } from '../lib/cacheKeys';
import { singleString, coerceDuration } from '../lib/validate';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const TRACK_TYPES = ['episode', 'single', 'mix', 'live'] as const;
type TrackType = (typeof TRACK_TYPES)[number];

const MAX_BULK_FILES = 50;

// A reorder issues one UPDATE per id, so the array length is what bounds the
// work done while holding a pool connection. 50 matches the bulk upload cap.
const MAX_REORDER_IDS = 50;

// Mirrors the VARCHAR(255) column widths. Without this, MySQL in strict mode
// rejects the statement outright and the request fails as an opaque 500 rather
// than a message naming the offending field.
const MAX_TITLE = 255;
const MAX_ARTIST = 255;
const MAX_ALBUM = 255;

/**
 * Reserves the next sort_order for a track in `programId`.
 *
 * `COUNT(*)` was used for this, which is wrong twice over: deleting a track from
 * the middle of a list drops the count, so the next upload reuses a live
 * sort_order; and two concurrent uploads both read the same count and both
 * insert it. Either collision leaves `ORDER BY sort_order, created_at` — the
 * order the whole player depends on — nondeterministic. `MAX + 1` under a row
 * lock closes both.
 *
 * Must be called inside a transaction so the lock is held through the INSERT.
 */
async function reserveSortOrder(
  conn: mysql.PoolConnection,
  programId: string
): Promise<number> {
  const [rows] = await conn.execute<any[]>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tracks WHERE program_id = ? FOR UPDATE',
    [programId]
  );
  return Number(rows[0]?.next ?? 0);
}

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
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: MAX_BULK_FILES,
    // busboy applies no default cap on non-file fields, so `titles`/`artists`/
    // `albums` were unbounded in both count and size on a 50-file batch.
    fields: 200,
    fieldSize: 1024,
  },
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
  const { title, artist, album, program_id, track_type } = req.body ?? {};

  // Every branch below has to release req.file, so validation failures are
  // funnelled through this one helper rather than repeating cleanupFiles.
  const invalid = (error: string, status = 400) => {
    cleanupFiles([req.file]);
    return res.status(status).json({ error });
  };

  const cleanTitle = singleString(title);
  if (!cleanTitle) return invalid('Title is required');
  if (cleanTitle.length > MAX_TITLE) {
    return invalid(`Title must be ${MAX_TITLE} characters or fewer`);
  }

  const cleanArtist = singleString(artist);
  const cleanAlbum = singleString(album);
  if (cleanArtist && cleanArtist.length > MAX_ARTIST) {
    return invalid(`Artist must be ${MAX_ARTIST} characters or fewer`);
  }
  if (cleanAlbum && cleanAlbum.length > MAX_ALBUM) {
    return invalid(`Album must be ${MAX_ALBUM} characters or fewer`);
  }

  const cleanProgramId = singleString(program_id);
  if (!cleanProgramId) return invalid('Program ID is required');

  const cleanTrackType = singleString(track_type) || 'episode';
  if (!TRACK_TYPES.includes(cleanTrackType as TrackType)) {
    return invalid('Invalid track type');
  }

  const duration = coerceDuration(req.body?.duration, 0);
  if (duration === null) return invalid('Invalid duration');

  if (!req.file) return invalid('Audio file required');

  const program = await queryOne('SELECT id FROM programs WHERE id = ?', [cleanProgramId]);
  if (!program) {
    // A missing parent is a 404, not a bad request: keep the status the caller
    // saw before validation was factored into the helper.
    return invalid('Program not found', 404);
  }

  const id = uuidv4();
  let sortOrder: number;
  try {
    // The row lock taken by reserveSortOrder has to be held through the INSERT,
    // so both statements share one transaction.
    sortOrder = await withTransaction(async (conn) => {
      const next = await reserveSortOrder(conn, cleanProgramId);
      await conn.execute(
        'INSERT INTO tracks (id, title, artist, album, duration, file_path, program_id, track_type, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, cleanTitle, cleanArtist || null, cleanAlbum || null, duration, req.file!.filename, cleanProgramId, cleanTrackType, next, req.user!.id]
      );
      return next;
    });
  } catch (err) {
    // Multer has already written the upload to disk. Without this the file is
    // orphaned the moment the INSERT fails, with no row to ever find it by.
    cleanupFiles([req.file]);
    throw err;
  }

  await cacheDelete(...programReadCacheKeys(cleanProgramId));
  res.status(201).json({ id, title: cleanTitle, artist, album, file_path: req.file.filename, program_id: cleanProgramId, track_type: cleanTrackType, sort_order: sortOrder });
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

    const pool = getPool();
    const conn = await pool.getConnection();
    const uploaded: Array<{ id: string; title: string; file_path: string; sort_order: number }> = [];
    try {
      await conn.beginTransaction();
      let sortOrder = await reserveSortOrder(conn, program_id);
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const id = uuidv4();
        // The fallback is derived from a client-supplied filename, so it is
        // unbounded too: without the clamp a long filename overflows VARCHAR(255),
        // the INSERT throws, the transaction rolls back and a legitimate upload
        // fails with a 500.
        const trackTitle = ((titles[i] ? String(titles[i]).trim() : '') || file.originalname.replace(/\.[^.]+$/, '')).slice(0, MAX_TITLE);
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

    await cacheDelete(...programReadCacheKeys(program_id));
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

  const { title, artist, album, track_type } = req.body ?? {};

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
  // A track always has some duration, so an absent field falls back to the
  // stored value rather than to 0.
  const updatedDuration = coerceDuration(req.body?.duration, track.duration);
  if (updatedDuration === null) {
    return res.status(400).json({ error: 'Invalid duration' });
  }

  // Optional fields can be explicitly cleared to null by sending an empty
  // string; absent fields keep their current value.
  const updatedTitle = title !== undefined && title.trim() ? title.trim() : track.title;
  const updatedArtist = artist !== undefined ? (artist || null) : track.artist;
  const updatedAlbum = album !== undefined ? (album || null) : track.album;
  const updatedType = track_type || track.track_type;

  await runSQL('UPDATE tracks SET title = ?, artist = ?, album = ?, track_type = ?, duration = ? WHERE id = ?',
    [updatedTitle, updatedArtist, updatedAlbum, updatedType, updatedDuration, req.params.id]);

  await cacheDelete(...programReadCacheKeys(track.program_id));
  res.json({ message: 'Track updated' });
}));

router.put('/reorder/:programId', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { trackIds } = req.body ?? {};
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return res.status(400).json({ error: 'trackIds array required' });
  }
  // Each id costs one UPDATE on the same connection, so an unbounded array
  // monopolises a slot from the pool of 10 for as long as it runs.
  if (trackIds.length > MAX_REORDER_IDS) {
    return res.status(400).json({ error: `At most ${MAX_REORDER_IDS} tracks can be reordered at once` });
  }
  // mysql2 cannot bind an object or an array, and ids reach this point straight
  // from the request body.
  if (!trackIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
    return res.status(400).json({ error: 'trackIds must be non-empty strings' });
  }

  const programId = singleString(req.params.programId);
  if (!programId) return res.status(400).json({ error: 'Invalid program id' });

  await withTransaction(async (conn) => {
    for (let index = 0; index < trackIds.length; index++) {
      await conn.execute('UPDATE tracks SET sort_order = ? WHERE id = ? AND program_id = ?',
        [index, trackIds[index], programId]);
    }
  });

  await cacheDelete(...programReadCacheKeys(programId));
  res.json({ message: 'Order updated' });
}));

router.delete('/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const track = await queryOne<{ file_path: string | null; program_id: string }>(
    'SELECT file_path, program_id FROM tracks WHERE id = ?',
    [req.params.id]
  );
  if (!track) return res.status(404).json({ error: 'Track not found' });

  await runSQL('DELETE FROM tracks WHERE id = ?', [req.params.id]);
  await cacheDelete(...programReadCacheKeys(track.program_id));

  if (track.file_path) {
    // basename() as defence in depth: file_path is server-generated, but the
    // unlink runs against the filesystem and should never be steerable by it.
    fs.unlink(path.join(UPLOADS_ROOT, 'tracks', path.basename(track.file_path))).catch(() => {});
  }

  res.json({ message: 'Track deleted' });
}));

export default router;
