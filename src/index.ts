import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import fsSync from 'fs';

import { initDB, closePool } from './database/schema';
import { closeRedis } from './cache/redis';

import authRoutes from './routes/auth';
import programRoutes from './routes/programs';
import trackRoutes from './routes/tracks';
import publicRoutes from './routes/public';
import analyticsRoutes from './routes/analytics';
import contactRoutes from './routes/contact';

import { generalLimiter, browseLimiter, authLimiter } from './middleware/rateLimit';

dotenv.config();

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const UPLOAD_TYPES = ['tracks', 'covers'] as const;

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

// Tells download managers (IDM and friends) that these files are meant for
// inline playback, not saving. Without it they see audio/* and offer to
// capture every track the player streams.
const INLINE_HEADERS = { 'Content-Disposition': 'inline' } as const;

// INLINE_HEADERS alone is not enough. IDM classifies a response as a file to
// save from the *extension in the URL* first, and a byte-range-capable audio/*
// stream is its exact "resumable download" profile, so it captured every track
// regardless of the disposition header.
//
// Audio is therefore streamed from an extensionless `<uuid>.stream` URL. There
// is no recognisable extension for IDM to build a download task around, so the
// capture prompt never appears. The file on disk keeps its real extension, so
// the stem is resolved back to it against the list below.
const STREAM_SUFFIX = '.stream';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

/**
 * Maps a request filename to a real file in `typeRoot`, or null if there is
 * none.
 *
 * `filename` must already be basename()-collapsed by the caller.
 *
 * The exact name is tried first so cover images, and any future upload whose
 * extension is literally `.stream`, keep working unchanged. Only then is the
 * `.stream` suffix stripped and the stem matched against the real directory
 * listing. Matching entries rather than building candidate paths means a
 * traversal attempt cannot escape: nothing that is not already a name in that
 * one directory can ever match.
 */
function resolveUploadFile(typeRoot: string, filename: string): string | null {
  const direct = path.join(typeRoot, filename);
  if (fsSync.existsSync(direct)) return direct;

  if (!filename.toLowerCase().endsWith(STREAM_SUFFIX)) return null;

  let entries: string[];
  try {
    entries = fsSync.readdirSync(typeRoot);
  } catch {
    return null;
  }

  // Compared case-insensitively because tracks.ts stores the upload's original
  // extension verbatim (`path.extname(file.originalname)`), so an uploaded
  // `SONG.MP3` lands on disk with an uppercase extension.
  const wanted = AUDIO_EXTENSIONS.map((ext) => (filename.slice(0, -STREAM_SUFFIX.length) + ext).toLowerCase());

  // Joined back onto typeRoot: readdirSync yields bare entry names, and the
  // caller needs a path it can stat and stream.
  const match = entries.find((entry) => wanted.includes(entry.toLowerCase()));
  return match ? path.join(typeRoot, match) : null;
}

export function createApp() {
  const app = express();

  const PORT = Number(process.env.PORT) || 5000;

  // Trust one reverse proxy hop (Apache/nginx/caddy) only when explicitly
  // configured, so rate limits and req.ip are based on the real client IP.
  // If the server is directly reachable, keep this off: otherwise clients
  // can spoof X-Forwarded-For to bypass every rate limiter.
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  // Security.
  //
  // The API only ever returns JSON, so its CSP is a hard deny: no scripts, no
  // styles, no frames. The policy that governs the actual pages is set by
  // nginx, which is what serves the HTML.
  //
  // COEP/CORP stay off: audio is fetched cross-origin by the player and the
  // cover images are read from other origins, so cross-origin isolation would
  // break playback rather than protect it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    })
  );

  // Body parser
  app.use(express.json({ limit: '1mb' }));

  // CORS. The session cookie is SameSite=Lax, so a cross-site POST never
  // carries it; the exact-origin allowlist below stops any other origin from
  // reading credentialed responses.
  app.use(
    cors({
      origin: [
        'https://yemisrachdimts.elacodes.com',
        'http://localhost:5173',
        'https://ydcsradio.elacodes.com',
        'https://yemisrach.elacodes.com',
      ],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      // x-client-fingerprint carries the anonymous listener id used for like and
      // listen dedup; without it the browser preflight rejects those calls.
      allowedHeaders: ['Content-Type', 'Authorization', 'x-client-fingerprint'],
      credentials: true,
    })
  );

  // One general limiter for the whole API. Individual routers add stricter
  // limiters on top (login, contact, writes) where they need to, so mounting
  // generalLimiter again per-router just double-counted the same window.
  app.use('/api/', generalLimiter);

  console.log('Uploads directory:', UPLOADS_ROOT);

  app.get('/api/uploads/:type/:filename', (req, res) => {
    const { type, filename } = req.params;
    if (!(UPLOAD_TYPES as readonly string[]).includes(type)) {
      return res.status(404).json({ error: 'Invalid type' });
    }

    // basename() strips every directory component, so `..` and absolute paths
    // cannot survive. The realpath check then confirms the resolved file is
    // still inside this type's directory rather than a sibling that merely
    // shares its name as a string prefix.
    const safeFilename = path.basename(filename);
    const typeRoot = path.resolve(UPLOADS_ROOT, type);
    const filePath = path.resolve(typeRoot, safeFilename);
    if (path.dirname(filePath) !== typeRoot) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = resolveUploadFile(typeRoot, safeFilename);
    if (!resolved) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Derived from the file that was actually found, not from the request name:
    // a `.stream` request must still be answered as the audio type it is, or
    // the <audio> element refuses it.
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isAudio = contentType.startsWith('audio/');

    fsSync.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        return res.status(404).json({ error: 'File not found' });
      }
      const fileSize = stat.size;
      const range = req.headers.range;

      if (!range) {
        // Declaring Content-Length without piping the bytes leaves the client
        // waiting for a body that never arrives, so the whole-file case has to
        // stream too rather than just ending the response.
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': isAudio ? 'bytes' : 'none',
          'Cache-Control': 'public, max-age=31536000',
          ...INLINE_HEADERS,
        });
        const whole = fsSync.createReadStream(resolved);
        whole.on('error', () => res.destroy());
        return whole.pipe(res);
      }

      const unsatisfiable = () =>
        res.status(416).set('Content-Range', `bytes */${fileSize}`).json({ error: 'Range not satisfiable' });

      // Only a single explicit byte range is supported; multipart ranges are
      // rejected rather than silently served as the whole file.
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return unsatisfiable();

      // Two forms, per RFC 7233. `bytes=100-200` is absolute on both ends.
      // `bytes=-500` has an empty start and means "the LAST 500 bytes", which
      // is not the same as "bytes 0-500"; treating the suffix as an absolute
      // end would serve the wrong bytes from the start of the file.
      const hasStart = match[1] !== '';
      const hasEnd = match[2] !== '';

      if (!hasStart && !hasEnd) return unsatisfiable();

      let start: number;
      let end: number;

      if (!hasStart) {
        // Suffix range. Clamp a suffix longer than the file to the whole file.
        const suffix = parseInt(match[2]!, 10);
        if (Number.isNaN(suffix) || suffix < 0) return unsatisfiable();
        start = Math.max(0, fileSize - suffix);
        end = fileSize - 1;
      } else {
        start = parseInt(match[1]!, 10);
        end = hasEnd ? parseInt(match[2]!, 10) : fileSize - 1;
        if (Number.isNaN(end)) return unsatisfiable();
        end = Math.min(end, fileSize - 1);
      }

      if (Number.isNaN(start) || start < 0 || end < start || start >= fileSize) {
        return unsatisfiable();
      }
      const chunkSize = end - start + 1;
      const file = fsSync.createReadStream(resolved, { start, end });
      file.on('error', () => res.destroy());
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000',
        ...INLINE_HEADERS,
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

  // authLimiter is scoped to login only so admin CRUD isn't throttled
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/programs', programRoutes);
  app.use('/api/tracks', trackRoutes);
  app.use('/api/public', browseLimiter, publicRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/contact', contactRoutes);

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
          // Name the field so a 15 MB cover cap and a 100 MB track cap are not
          // reported with one ambiguous "File too large". multer's own types
          // omit `limit`, so it is read off the error defensively.
          const { field, limit } = err as multer.MulterError & { limit?: number };
          const which = field ? ` (${field})` : '';
          const max = typeof limit === 'number'
            ? ` Max is ${Math.floor(limit / (1024 * 1024))} MB.`
            : '';
          return res.status(413).json({ error: `File too large${which}.${max}` });
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

  return { app, port: PORT };
}

export async function start() {
  try {
    await initDB();
    console.log('Database initialized.');

    const { app, port } = createApp();
    const server = app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

    const shutdown = (signal: string) => {
      console.log(`\n${signal} received, shutting down.`);
      server.close(() => {
        Promise.all([closePool(), closeRedis()]).finally(() => process.exit(0));
      });
      // Don't hang forever on lingering keep-alive or websocket connections.
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return server;
  } catch (error) {
    console.error('Application startup failed:', error);
    process.exit(1);
  }
}

// Only listen when run directly, so tests can import createApp without binding a port.
if (require.main === module) {
  start();
}
