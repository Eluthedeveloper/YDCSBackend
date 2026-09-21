import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import fsSync from 'fs';

import { initDB } from './database/schema';
import { sanitizeBody } from './lib/sanitize';

import authRoutes from './routes/auth';
import programRoutes from './routes/programs';
import trackRoutes from './routes/tracks';
import publicRoutes from './routes/public';
import analyticsRoutes from './routes/analytics';
import contactRoutes from './routes/contact';

dotenv.config();

async function start() {
  try {
    await initDB();
    console.log('Database initialized.');

    const app = express();
    const PORT = Number(process.env.PORT) || 5000;

    // Trust one reverse proxy hop (Apache/nginx/caddy) only when explicitly
    // configured, so rate limits and req.ip are based on the real client IP.
    // If the server is directly reachable, keep this off: otherwise clients
    // can spoof X-Forwarded-For to bypass every rate limiter.
    if (process.env.TRUST_PROXY === 'true') {
      app.set('trust proxy', 1);
    }

    // Security
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
      })
    );

    // Body parser
    app.use(express.json({ limit: '10mb' }));

    // CORS
    app.use(
      cors({
        origin: [
          'https://yemisrachdimts.elacodes.com',
          'http://localhost:5173',
          'https://ydcsradio.elacodes.com',
          'https://yemisrach.elacodes.com',
        ],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
      })
    );

    // Rate limits
    const generalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500,
      standardHeaders: true,
      legacyHeaders: false,
    });

    const browseLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      standardHeaders: true,
      legacyHeaders: false,
    });

    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.use('/api/', generalLimiter);

    // XSS sanitize middleware (JSON bodies; multipart runs it again post-multer)
    app.use(sanitizeBody);

    // MULTER UPLOADS STATIC FILES
    const uploadsPath = path.join(process.cwd(), 'uploads');
    console.log('Uploads directory:', uploadsPath);

    app.get('/api/uploads/:type/:filename', (req, res) => {
      const { type, filename } = req.params;
      if (type !== 'tracks' && type !== 'covers') {
        return res.status(404).json({ error: 'Invalid type' });
      }
      const safeFilename = path.basename(filename);
      const filePath = path.resolve(uploadsPath, type, safeFilename);
      if (!filePath.startsWith(path.resolve(uploadsPath, type))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const ext = path.extname(safeFilename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const isAudio = contentType.startsWith('audio/');
      fsSync.stat(filePath, (err: any, stat: any) => {
        if (err) {
          return res.status(404).json({ error: 'File not found' });
        }
        const fileSize = stat.size;
        const range = req.headers.range;

        if (!range) {
          return res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': isAudio ? 'bytes' : 'none',
            'Cache-Control': 'public, max-age=31536000',
          }).end();
        }

        const unsatisfiable = () =>
          res.status(416).set('Content-Range', `bytes */${fileSize}`).json({ error: 'Range not satisfiable' });

        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return unsatisfiable();

        const start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= fileSize) {
          return unsatisfiable();
        }

        end = Math.min(end, fileSize - 1);
        const chunkSize = end - start + 1;
        const file = fsSync.createReadStream(filePath, { start, end });
        file.on('error', () => res.destroy());
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
        });
        file.pipe(res);
      });
    });

    // Health routes
    app.get('/', (_req, res) => {
      res.json({
        message: 'YDCS Backend API is running',
        status: 'OK',
        time: new Date(),
      });
    });

    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
      });
    });

    console.log('Registering API routes...');

    // API ROUTES
    // authLimiter is scoped to login only so admin CRUD isn't throttled
    app.use('/api/auth/login', authLimiter);
    app.use('/api/auth', generalLimiter, authRoutes);
    app.use('/api/programs', generalLimiter, programRoutes);
    app.use('/api/tracks', generalLimiter, trackRoutes);
    app.use('/api/public', browseLimiter, publicRoutes);
    app.use('/api/analytics', generalLimiter, analyticsRoutes);
    app.use('/api/contact', generalLimiter, contactRoutes);

    console.log('API routes registered.');

    // 404 handler
    app.use((_req, res) => {
      res.status(404).json({ error: 'Route not found' });
    });

    // Error handler
    app.use(
      (
        err: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large' });
          }
          return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        if (err && err.message === 'Invalid file type') {
          return res.status(400).json({ error: err.message });
        }
        console.error('SERVER ERROR:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    );

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('Application startup failed:', error);
    process.exit(1);
  }
}

start();
