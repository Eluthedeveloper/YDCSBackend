import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { queryAll, queryOne, runSQL } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { cacheInvalidate } from '../cache/redis';
import { sanitizeBody } from '../lib/sanitize';

const router = Router();

const coverStorage = multer.diskStorage({
  destination: './uploads/covers',
  filename: (_req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  }
});

router.get('/', authenticate, requireAdmin, async (_req, res: Response) => {
  try {
    const programs = await queryAll(`
      SELECT p.*, u.username as creator_name,
        (SELECT COUNT(*) FROM tracks WHERE program_id = p.id) as track_count
      FROM programs p
      JOIN users u ON p.created_by = u.id
      ORDER BY p.created_at DESC
    `);
    res.json(programs);
  } catch (err) {
    console.error('Error fetching programs:', err);
    res.status(500).json({ error: 'Failed to fetch programs' });
  }
});

router.get('/comments/all', authenticate, requireAdmin, async (_req, res: Response) => {
  try {
    const comments = await queryAll(`
      SELECT c.*, p.title as program_title
      FROM comments c
      JOIN programs p ON c.program_id = p.id
      ORDER BY c.created_at DESC
    `);
    res.json(comments);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.get('/:id', authenticate, requireAdmin, async (req, res: Response) => {
  try {
    const program = await queryOne(`
      SELECT p.*, u.username as creator_name
      FROM programs p
      JOIN users u ON p.created_by = u.id
      WHERE p.id = ?
    `, [req.params.id]);

    if (!program) return res.status(404).json({ error: 'Program not found' });

    const tracks = await queryAll('SELECT * FROM tracks WHERE program_id = ? ORDER BY created_at ASC', [req.params.id]);

    res.json({ ...program, tracks });
  } catch (err) {
    console.error('Error fetching program:', err);
    res.status(500).json({ error: 'Failed to fetch program' });
  }
});

router.post('/', authenticate, requireAdmin, uploadCover.single('cover_image'), sanitizeBody, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const id = uuidv4();
    const cover_image = req.file ? req.file.filename : null;

    await runSQL('INSERT INTO programs (id, title, description, cover_image, created_by) VALUES (?, ?, ?, ?, ?)',
      [id, title.trim(), description || null, cover_image, req.user!.id]);

    await cacheInvalidate('public:*');
    res.json({ id, title: title.trim(), description, cover_image, created_by: req.user!.id });
  } catch (err) {
    console.error('Error creating program:', err);
    res.status(500).json({ error: 'Failed to create program' });
  }
});

router.put('/:id', authenticate, requireAdmin, uploadCover.single('cover_image'), sanitizeBody, async (req: AuthRequest, res: Response) => {
  try {
    const program = await queryOne('SELECT * FROM programs WHERE id = ?', [req.params.id]) as any;
    if (!program) return res.status(404).json({ error: 'Program not found' });

    if (req.user!.role !== 'super_admin' && program.created_by !== req.user!.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { title, description } = req.body;
    const cover_image = req.file ? req.file.filename : program.cover_image;

    await runSQL('UPDATE programs SET title = ?, description = ?, cover_image = ? WHERE id = ?',
      [title || program.title, description || program.description, cover_image, req.params.id]);

    await cacheInvalidate('public:*');
    res.json({ message: 'Program updated' });
  } catch (err) {
    console.error('Error updating program:', err);
    res.status(500).json({ error: 'Failed to update program' });
  }
});

router.get('/:id/comments', authenticate, requireAdmin, async (req, res: Response) => {
  try {
    const program = await queryOne('SELECT id FROM programs WHERE id = ?', [req.params.id]);
    if (!program) return res.status(404).json({ error: 'Program not found' });

    const comments = await queryAll(`
      SELECT * FROM comments WHERE program_id = ? ORDER BY created_at DESC
    `, [req.params.id]);

    res.json(comments);
  } catch (err) {
    console.error('Error fetching program comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.delete('/:id', authenticate, requireSuperAdmin, async (req, res: Response) => {
  try {
    const tracks = await queryAll('SELECT file_path FROM tracks WHERE program_id = ?', [req.params.id]);
    const program = await queryOne('SELECT cover_image FROM programs WHERE id = ?', [req.params.id]) as any;

    await runSQL('DELETE FROM tracks WHERE program_id = ?', [req.params.id]);
    await runSQL('DELETE FROM programs WHERE id = ?', [req.params.id]);
    await cacheInvalidate('public:*');

    for (const track of tracks) {
      if (track.file_path) {
        fs.unlink(path.join('uploads', 'tracks', track.file_path)).catch(() => {});
      }
    }
    if (program?.cover_image) {
      fs.unlink(path.join('uploads', 'covers', program.cover_image)).catch(() => {});
    }

    res.json({ message: 'Program deleted' });
  } catch (err) {
    console.error('Error deleting program:', err);
    res.status(500).json({ error: 'Failed to delete program' });
  }
});

export default router;
