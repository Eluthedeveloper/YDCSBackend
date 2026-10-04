import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { queryAll, queryOne, runSQL } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimit';
import { cacheInvalidate } from '../cache/redis';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const ALLOWED_COVER_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.webp'];
const ALLOWED_COVER_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

// Mirrors the VARCHAR(255) column widths. MySQL in strict mode would otherwise
// reject the whole statement with an opaque 500 once a field ran over.
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 5000;
// 15 MB. A 5 MB cap rejected ordinary phone photos, and because the modal
// stays open on failure it read as an unresponsive Save button rather than an
// upload error. The frontend checks this same value before sending.
const MAX_COVER_BYTES = 15 * 1024 * 1024;
export const MAX_COVER_MB = Math.floor(MAX_COVER_BYTES / (1024 * 1024));

interface ProgramRow {
  id: string;
  title: string;
  description: string | null;
  cover_image: string | null;
  created_by: string;
}

const coverStorage = multer.diskStorage({
  destination: './uploads/covers',
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: MAX_COVER_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // An explicit rejection gives the admin a real error instead of the
    // confusing "no file was attached" that cb(null, false) produces.
    if (!ALLOWED_COVER_EXTENSIONS.includes(ext) || !ALLOWED_COVER_MIMES.includes(file.mimetype)) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  }
});

function removeCover(filename?: string | null) {
  if (filename) {
    fs.unlink(path.join(UPLOADS_ROOT, 'covers', path.basename(filename))).catch(() => {});
  }
}

router.get('/', authenticate, requireAdmin, asyncHandler(async (_req, res: Response) => {
  const programs = await queryAll(`
    SELECT p.*, u.username as creator_name,
      (SELECT COUNT(*) FROM tracks WHERE program_id = p.id) as track_count
    FROM programs p
    JOIN users u ON p.created_by = u.id
    ORDER BY p.created_at DESC
  `);
  res.json(programs);
}));

// Registered before '/:id' so "comments" is never parsed as a program id.
router.get('/comments/all', authenticate, requireAdmin, asyncHandler(async (_req, res: Response) => {
  const comments = await queryAll(`
    SELECT c.*, p.title as program_title
    FROM comments c
    JOIN programs p ON c.program_id = p.id
    ORDER BY c.created_at DESC
  `);
  res.json(comments);
}));

router.get('/:id', authenticate, requireAdmin, asyncHandler(async (req, res: Response) => {
  const program = await queryOne(`
    SELECT p.*, u.username as creator_name
    FROM programs p
    JOIN users u ON p.created_by = u.id
    WHERE p.id = ?
  `, [req.params.id]);

  if (!program) return res.status(404).json({ error: 'Program not found' });

  const tracks = await queryAll('SELECT * FROM tracks WHERE program_id = ? ORDER BY sort_order ASC, created_at ASC', [req.params.id]);

  res.json({ ...program, tracks });
}));

router.post('/', writeLimiter, authenticate, requireAdmin, uploadCover.single('cover_image'), asyncHandler(async (req: AuthRequest, res: Response) => {
  try {
    const { title, description } = req.body ?? {};
    if (!title || !title.trim()) {
      removeCover(req.file?.filename);
      return res.status(400).json({ error: 'Title is required' });
    }
    if (String(title).trim().length > MAX_TITLE) {
      removeCover(req.file?.filename);
      return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION) {
      removeCover(req.file?.filename);
      return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION} characters or fewer` });
    }

    const id = uuidv4();
    const cover_image = req.file ? req.file.filename : null;

    await runSQL('INSERT INTO programs (id, title, description, cover_image, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, title.trim(), description || null, cover_image, req.user!.id]);

    await cacheInvalidate('public:*');
    res.status(201).json({ id, title: title.trim(), description, cover_image, created_by: req.user!.id });
  } catch (err) {
    removeCover(req.file?.filename);
    throw err;
  }
}));

router.put('/:id', writeLimiter, authenticate, requireAdmin, uploadCover.single('cover_image'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const program = await queryOne<ProgramRow>('SELECT * FROM programs WHERE id = ?', [req.params.id]);
  if (!program) {
    removeCover(req.file?.filename);
    return res.status(404).json({ error: 'Program not found' });
  }

  if (req.user!.role !== 'super_admin' && program.created_by !== req.user!.id) {
    removeCover(req.file?.filename);
    return res.status(403).json({ error: 'Not authorized' });
  }

  const { title, description } = req.body ?? {};

  if (typeof title === 'string' && title.trim().length > MAX_TITLE) {
    removeCover(req.file?.filename);
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  if (typeof description === 'string' && description.length > MAX_DESCRIPTION) {
    removeCover(req.file?.filename);
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION} characters or fewer` });
  }

  const cover_image = req.file ? req.file.filename : program.cover_image;

  // Description is cleared by sending an empty string, matching how artist and
  // album are handled in tracks.ts; absent fields keep their current value.
  const updatedTitle = title !== undefined && title.trim() ? title.trim() : program.title;
  const updatedDescription = description !== undefined ? (description || null) : program.description;

  await runSQL('UPDATE programs SET title = ?, description = ?, cover_image = ? WHERE id = ?',
    [updatedTitle, updatedDescription, cover_image, req.params.id]);

  // cover_image is a fresh UUID whenever req.file exists, so the old file is
  // always the one to remove here.
  if (req.file) {
    removeCover(program.cover_image);
  }

  await cacheInvalidate('public:*');
  res.json({ message: 'Program updated' });
}));

router.get('/:id/comments', authenticate, requireAdmin, asyncHandler(async (req, res: Response) => {
  const program = await queryOne('SELECT id FROM programs WHERE id = ?', [req.params.id]);
  if (!program) return res.status(404).json({ error: 'Program not found' });

  const comments = await queryAll(`
    SELECT * FROM comments WHERE program_id = ? ORDER BY created_at DESC
  `, [req.params.id]);

  res.json(comments);
}));

router.delete('/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const tracks = await queryAll('SELECT file_path FROM tracks WHERE program_id = ?', [req.params.id]);
  const program = await queryOne<{ cover_image: string | null }>(
    'SELECT cover_image FROM programs WHERE id = ?',
    [req.params.id]
  );
  if (!program) return res.status(404).json({ error: 'Program not found' });

  // tracks and comments cascade from programs, so deleting the program is
  // enough; deleting tracks explicitly first only risks a partial failure.
  await runSQL('DELETE FROM programs WHERE id = ?', [req.params.id]);
  await cacheInvalidate('public:*');

  for (const track of tracks) {
    if (track.file_path) {
      fs.unlink(path.join(UPLOADS_ROOT, 'tracks', path.basename(track.file_path))).catch(() => {});
    }
  }
  removeCover(program.cover_image);

  res.json({ message: 'Program deleted' });
}));

export default router;
