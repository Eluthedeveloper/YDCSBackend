import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import fsSync from 'fs';

import { initDB, closePool, queryOne } from './database/schema';
import redis, { closeRedis } from './cache/redis';

import authRoutes from './routes/auth';
import programRoutes from './routes/programs';
import trackRoutes from './routes/tracks';
import publicRoutes from './routes/public';
import analyticsRoutes from './routes/analytics';
import contactRoutes from './routes/contact';
import siteRoutes from './routes/site';
import chatbotRoutes from './routes/chatbot';
import adminChatbotRoutes from './routes/adminChatbot';
import { invalidateChatbotCache } from './lib/chatbot';
import { mapWritePathToSource, scheduleContentSync, startChatbotSyncScheduler, syncAllContent } from './lib/chatbotSync';
import { ensureHlsPlaylist, HlsUnavailableError, HLS_ROOT, isSafeHlsStem, resolveTrackSource } from './lib/hls';

import { generalLimiter, browseLimiter, authLimiter, mediaLimiter } from './middleware/rateLimit';

dotenv.config();

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
// Upload directories the /api/uploads route will serve. Each entry is one
// subdirectory of ./uploads; the filenames are UUIDs, so the type segment is
// the only part of the URL that carries meaning.
const UPLOAD_TYPES = ['tracks', 'covers', 'leaders', 'albums', 'blogs'] as const;

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment', '.mp4': 'video/mp4',
};

// Tells download managers (IDM and friends) that these files are meant for
// inline playback, not saving. Without it they see audio/* and offer to
// capture every track the player streams.
const INLINE_HEADERS = { 'Content-Disposition': 'inline' } as const;

// INLINE_HEADERS alone is not enough. IDM first looks at the extension in the
// URL, and when that is unrecognisable it falls back to the response
// Content-Type — that is how a bare `.ts` module URL got saved as `metadata.JS`.
//
// Audio is therefore streamed from an extensionless `<uuid>.stream` URL, which
// leaves IDM no extension to build a download task around. The response still
// declares the real audio type, because a media element that is not typed as
// audio is refused outright by iOS Safari. The file on disk keeps its real
// extension, so the stem is resolved back to it against the list below.
const STREAM_SUFFIX = '.stream';

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

/**
 * What a `.stream` URL answers with.
 *
 * The extensionless URL is what keeps download managers from offering to save
 * every track the player streams. The neutral `application/octet-stream` type
 * was the second half of that defence, but it costs far more than it saves:
 * iOS Safari refuses to decode a media element whose response is not typed as
 * audio, so playback never starts there at all, and the browser reports it as
 * a generic failure the listener cannot act on.
 *
 * Mobile listeners are the ministry's audience; an IDM capture prompt is one
 * desktop annoyance. The real audio type is therefore sent by default.
 * `STREAM_CONTENT_TYPE=neutral` restores the old octet-stream answer.
 *
 * Read per request rather than once at import, so a deployment can be switched
 * without a rebuild and a test can exercise both answers.
 */
function streamContentTypeIsNeutral(): boolean {
  return (process.env.STREAM_CONTENT_TYPE || 'audio').toLowerCase() === 'neutral';
}

// Directory listings are cached briefly. The old resolver called readdirSync on
// every `.stream` request (a `.stream` URL never exists on disk, so the fast
// path always missed), which blocked the event loop and scanned the whole
// catalogue on every play and every seek. Async + a 1s cache keeps new uploads
// playable almost immediately while making a miss O(1).
const AUDIO_INDEX_TTL_MS = 1000;
const audioIndex = new Map<string, { entries: string[]; at: number; mtimeMs: number }>();

async function listAudioEntries(typeRoot: string): Promise<string[]> {
  const now = Date.now();
  const cached = audioIndex.get(typeRoot);
  const dir = await fsSync.promises.stat(typeRoot).catch(() => null);

  // A new upload changes the directory's mtime, so the listing is refreshed
  // immediately rather than waiting out the TTL (and stale entries from a
  // deleted file stop being served).
  if (cached && dir && cached.mtimeMs === dir.mtimeMs && now - cached.at < AUDIO_INDEX_TTL_MS) {
    return cached.entries;
  }

  try {
    const entries = await fsSync.promises.readdir(typeRoot);
    audioIndex.set(typeRoot, { entries, at: now, mtimeMs: dir?.mtimeMs ?? 0 });
    return entries;
  } catch {
    return cached?.entries ?? [];
  }
}

/**
 * Maps a request filename to a real file in `typeRoot`, or null if there is
 * none. Never blocks the event loop and never scans the directory more than
 * once per second per type.
 */
async function resolveUploadFile(typeRoot: string, filename: string): Promise<string | null> {
  const direct = path.join(typeRoot, filename);
  try {
    await fsSync.promises.access(direct);
    return direct;
  } catch {
    // Not a literal file; fall through to `.stream` resolution.
  }

  if (!filename.toLowerCase().endsWith(STREAM_SUFFIX)) return null;

  const stem = filename.slice(0, -STREAM_SUFFIX.length);
  if (!/^[A-Za-z0-9._-]+$/.test(stem)) return null;

  const entries = await listAudioEntries(typeRoot);

  // Compared case-insensitively because tracks.ts stores the upload's original
  // extension verbatim (`path.extname(file.originalname)`), so an uploaded
  // `SONG.MP3` lands on disk with an uppercase extension.
  const wanted = AUDIO_EXTENSIONS.map((ext) => (stem + ext).toLowerCase());

  // Joined back onto typeRoot: readdir yields bare entry names, and the caller
  // needs a path it can stat and stream.
  const match = entries.find((entry) => wanted.includes(entry.toLowerCase()));
  return match ? path.join(typeRoot, match) : null;
}

export function createApp() {
  const app = express();

  const PORT = Number(process.env.PORT) || 5000;

  // Trust reverse-proxy hops so rate limits and req.ip use the real client.
  //
  // TLS terminates in front of nginx (Cloudflare or a host panel), so the
  // chain is client → outer proxy → nginx → backend — two hops, not one.
  // With `trust proxy 1` Express took the last XFF entry (the outer proxy's
  // IP) as the client, collapsing every visitor onto one shared address and
  // exhausting generalLimiter for everyone. Accept either `true` (legacy,
  // two hops — matches this deployment) or an explicit hop count.
  //
  // If the server is directly reachable with no proxy, leave this unset:
  // otherwise clients can spoof X-Forwarded-For to bypass every limiter.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === 'true') {
    app.set('trust proxy', 2);
  } else if (trustProxy && Number.isInteger(Number(trustProxy)) && Number(trustProxy) > 0) {
    app.set('trust proxy', Number(trustProxy));
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
  //
  // CORS_ORIGINS lets a deployment trim the list. The Docker compose file sets
  // it without localhost, which only a `npm run dev` session needs.
  const corsOrigins = (process.env.CORS_ORIGINS ??
    'https://yemisrachdimts.org,https://www.yemisrachdimts.org,https://listen.yemisrachdimts.org,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      // x-client-fingerprint carries the anonymous listener id used for like and
      // listen dedup; without it the browser preflight rejects those calls.
      allowedHeaders: ['Content-Type', 'Authorization', 'x-client-fingerprint'],
      credentials: true,
    })
  );

  // Media reads get their own limiter instead of a blanket exemption. Audio
  // playback issues a burst of Range requests per seek, so it cannot share the
  // page limit — but unbounded access made the uploads route a free DoS surface.
  app.use('/api/', (req, res, next) => {
    if (req.method === 'GET' && req.originalUrl.startsWith('/api/uploads/')) {
      return mediaLimiter(req, res, next);
    }
    // Chunk uploads are exempt too: they are counted by chunkLimiter, which
    // is sized for the number of chunks a file needs. Counting them here as
    // well made the 500-per-15-minutes general limit trip halfway through a
    // single large upload, because one file is hundreds of chunk requests.
    if (req.method === 'POST' && req.originalUrl.startsWith('/api/tracks/upload/chunk/')) {
      return next();
    }
    generalLimiter(req, res, next);
  });

  console.log('Uploads directory:', UPLOADS_ROOT);

  // HLS playlists and segments. Kept separate from the generic uploads route
  // because the stem is a directory component, and because requesting the
  // playlist is what triggers packaging of a track that has never been played
  // through HLS before.
  app.get('/api/uploads/hls/:stem/:file', async (req, res) => {
    const { stem } = req.params;
    const requested = req.params.file;
    const file = path.basename(requested);
    if (!isSafeHlsStem(stem) || file !== requested || !/^[A-Za-z0-9._-]+$/.test(file)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const typeRoot = path.resolve(HLS_ROOT, stem);
    const filePath = path.resolve(typeRoot, file);
    if (path.dirname(filePath) !== typeRoot) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (file.toLowerCase().endsWith('.m3u8')) {
      const source = await resolveTrackSource(stem);
      if (!source) return res.status(404).json({ error: 'File not found' });
      try {
        await ensureHlsPlaylist(source, stem);
      } catch (error) {
        // The player treats 503 as "no HLS here" and uses the progressive
        // stream instead, so a server without ffmpeg still plays the catalogue.
        if (error instanceof HlsUnavailableError) {
          console.error('[hls]', error.message);
          return res.status(503).json({ error: 'HLS transcoding is not available' });
        }
        console.error('[hls] generation failed:', error);
        return res.status(500).json({ error: 'Could not prepare HLS stream' });
      }
    }

    let stat: import('fs').Stats;
    try {
      stat = await fsSync.promises.stat(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!stat.isFile()) return res.status(404).json({ error: 'File not found' });

    const ext = path.extname(file).toLowerCase();
    const isPlaylist = ext === '.m3u8';

    // Segments are immutable and can be large in aggregate, so nginx serves
    // them straight from the read-only uploads mount. The playlist stays on
    // Node because it must be generated and revalidated, and because it is
    // tiny.
    const accelPrefix = process.env.X_ACCEL_PREFIX;
    if (!isPlaylist && accelPrefix) {
      return res
        .status(200)
        .set(
          'X-Accel-Redirect',
          `${accelPrefix.replace(/\/+$/, '')}/hls/${encodeURIComponent(stem)}/${encodeURIComponent(file)}`
        )
        .end();
    }

    res.set('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.set('Content-Disposition', 'inline');
    // Segments are immutable (their names change on regeneration); the
    // playlist must be revalidated so a regenerated track is picked up.
    res.set('Cache-Control', isPlaylist ? 'no-cache' : 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  });

  app.get('/api/uploads/:type/:filename', async (req, res) => {
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

    const resolved = await resolveUploadFile(typeRoot, safeFilename);
    if (!resolved) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Derived from the file that was actually found, not from the request name:
    // a `.stream` request still needs byte ranges accepted, and the real type
    // decides that. The URL stays extensionless so a download manager has no
    // media extension to name a capture after.
    const ext = path.extname(resolved).toLowerCase();
    const realType = MIME_TYPES[ext] || 'application/octet-stream';
    const isAudio = realType.startsWith('audio/');
    const isStreamRequest = safeFilename.toLowerCase().endsWith(STREAM_SUFFIX);
    // The URL stays extensionless (IDM looks at the extension first); the type
    // is the real audio type unless the deployment opts back into the neutral
    // answer. See STREAM_CONTENT_TYPE for why.
    const contentType =
      isStreamRequest && streamContentTypeIsNeutral() ? 'application/octet-stream' : realType;

    let stat: import('fs').Stats;
    try {
      stat = await fsSync.promises.stat(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Offload the bytes to nginx. Express answers with a header only and the
    // frontend nginx — which has the uploads directory mounted read-only —
    // streams the file itself, so Node never copies a byte of audio. Range
    // requests are answered by nginx too, which is what makes the double
    // (whole-file and seek) streaming load disappear.
    //
    // Only audio takes this path: images need the extension-driven
    // Content-Type, and the internal location maps audio extensions to their
    // real type (a neutral octet-stream answer would stop iOS Safari from
    // decoding the stream at all).
    // Unset X_ACCEL_PREFIX to fall back to streaming through Node.
    const accelPrefix = process.env.X_ACCEL_PREFIX;
    if (isAudio && accelPrefix) {
      return res
        .status(200)
        .set(
          'X-Accel-Redirect',
          `${accelPrefix.replace(/\/+$/, '')}/${type}/${encodeURIComponent(path.basename(resolved))}`
        )
        .end();
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
      // Client aborts (seek, tab close) must release the descriptor instead of
      // waiting for GC; a flood of aborted requests otherwise exhausts fds.
      res.on('close', () => whole.destroy());
      return whole.pipe(res);
    }

    const unsatisfiable = () =>
      res.status(416).set('Content-Range', `bytes */${fileSize}`).json({ error: 'Range not satisfiable' });

    // Only a single explicit byte range is supported; multipart ranges are
    // rejected rather than silently served as the whole file.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return unsatisfiable();

    // Two forms, per RFC 7233. `bytes=100-200` is absolute on both ends.
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
    res.on('close', () => file.destroy());
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

  // Health routes
  app.get('/', (_req, res) => {
    res.json({
      message: 'YDCS Backend API is running',
      status: 'OK',
      time: new Date(),
    });
  });

  // Liveness stays dependency-free: the process is alive even while MySQL is
  // briefly unreachable. Readiness is what the Docker healthcheck uses, so a
  // broken database or cache actually shows up as an unhealthy container.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    });
  });

  app.get('/health/ready', async (_req, res) => {
    const checks = { database: 'ok', redis: redis ? 'ok' : 'disabled' };
    let healthy = true;

    try {
      await queryOne('SELECT 1');
    } catch {
      checks.database = 'unavailable';
      healthy = false;
    }

    if (redis) {
      try {
        await redis.ping();
      } catch {
        checks.redis = 'unavailable';
        healthy = false;
      }
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ready' : 'not ready',
      checks,
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    });
  });

  // Event-driven knowledge sync: successful content writes schedule a debounced
  // refresh of the chatbot's searchable knowledge. The router below never
  // blocks the response, and the periodic scheduler is a backup.
  if (process.env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const source = mapWritePathToSource(req.method, req.originalUrl);
        if (source) scheduleContentSync(source.table, source.id);
      });
      next();
    });
  }

  console.log('Registering API routes...');

  // authLimiter is scoped to login only so admin CRUD isn't throttled
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/programs', programRoutes);
  app.use('/api/tracks', trackRoutes);
  app.use('/api/site', siteRoutes);
  app.use('/api/public', browseLimiter, publicRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/chatbot', chatbotRoutes);
  app.use('/api/admin/chatbot', adminChatbotRoutes);

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
      // express.raw / express.json body-parser rejects. Without this a chunk
      // over the limit surfaces as a generic 500 instead of a clear 413.
      if (err && typeof err.status === 'number' && err.status === 413) {
        return res.status(413).json({ error: 'Request body too large' });
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
    await invalidateChatbotCache();
    void syncAllContent().catch((error) => console.error('[chatbot] initial content sync failed:', error));
    startChatbotSyncScheduler();

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

    // Without these, a stray rejection or thrown error kills the process with
    // no record of why. Log first, then exit so the container restarts cleanly.
    process.on('unhandledRejection', (reason) => {
      console.error('[process] Unhandled promise rejection:', reason);
      process.exit(1);
    });
    process.on('uncaughtException', (error) => {
      console.error('[process] Uncaught exception:', error);
      process.exit(1);
    });

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
