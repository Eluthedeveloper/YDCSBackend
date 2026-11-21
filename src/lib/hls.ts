import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * On-demand HLS packaging for the existing uploads.
 *
 * The catalogue is a directory of finished audio files, not a live packager,
 * so a playlist is built the first time a track is requested and then reused.
 * ffmpeg does the work (AAC in MPEG-TS, which every HLS client understands);
 * if it is not installed the request fails with `HlsUnavailableError` and the
 * player falls back to the progressive `.stream` URL.
 */

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const TRACKS_ROOT = path.join(UPLOADS_ROOT, 'tracks');
export const HLS_ROOT = path.join(UPLOADS_ROOT, 'hls');

/** Stems are upload UUIDs; the same character set the `.stream` resolver accepts. */
const SAFE_STEM = /^[A-Za-z0-9._-]+$/;

export function isSafeHlsStem(stem: string): boolean {
  return SAFE_STEM.test(stem) && !stem.includes('..');
}

export class HlsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlsUnavailableError';
  }
}

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function segmentSeconds(): number {
  const raw = Number(process.env.HLS_SEGMENT_SECONDS);
  return Number.isFinite(raw) && raw >= 2 && raw <= 30 ? raw : 6;
}

function audioBitrate(): string {
  return process.env.HLS_AUDIO_BITRATE || '128k';
}

function timeoutMs(): number {
  const raw = Number(process.env.HLS_FFMPEG_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

function maxConcurrency(): number {
  const raw = Number(process.env.HLS_MAX_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

// One ffmpeg process per stem, however many listeners hit play at once.
const inFlight = new Map<string, Promise<string>>();

// A small cap on concurrent transcodes so a burst of first plays cannot pin
// every CPU core. Requests beyond it wait their turn rather than failing.
let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  const limit = maxConcurrency();
  if (running >= limit) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`ffmpeg timed out after ${timeoutMs()} ms`));
    }, timeoutMs());

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(new HlsUnavailableError(`ffmpeg not found (tried "${ffmpegPath()}")`));
      } else {
        finish(error);
      }
    });

    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

async function generate(sourcePath: string, stem: string): Promise<string> {
  await fs.promises.mkdir(HLS_ROOT, { recursive: true });

  const tmpDir = path.join(HLS_ROOT, `.tmp-${stem}-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const playlist = path.join(tmpDir, 'index.m3u8');
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath,
    '-vn',
    '-c:a', 'aac',
    '-b:a', audioBitrate(),
    '-ac', '2',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', String(segmentSeconds()),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(tmpDir, 'seg%05d.ts'),
    playlist,
  ];

  try {
    await withSlot(() => runFfmpeg(args));

    // ffmpeg normally writes segment basenames, but some builds echo the
    // `-hls_segment_filename` value verbatim. Strip the temporary directory so
    // the playlist is always portable and never leaks a server path.
    const raw = await fs.promises.readFile(playlist, 'utf8');
    const forward = tmpDir.replace(/\\/g, '/');
    // Longest first, so removing the trailing separator does not leave a
    // leading slash on the segment line.
    const variants = [tmpDir + path.sep, forward + '/', tmpDir, forward].sort(
      (a, b) => b.length - a.length
    );
    let portable = raw;
    for (const prefix of variants) portable = portable.split(prefix).join('');
    if (portable !== raw) await fs.promises.writeFile(playlist, portable);

    // Swap the finished directory into place. A listener who requested the
    // previous copy keeps their open handles; new requests see the new one.
    const destDir = path.join(HLS_ROOT, stem);
    await fs.promises.rm(destDir, { recursive: true, force: true });
    await fs.promises.rename(tmpDir, destDir);
    return path.join(destDir, 'index.m3u8');
  } catch (error) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Returns the playlist path for a track, building it if the cached copy is
 * missing or older than the source file.
 *
 * Concurrent callers share one generation promise, so a cold track played by
 * many listeners at once runs ffmpeg exactly once.
 */
export async function ensureHlsPlaylist(sourcePath: string, stem: string): Promise<string> {
  if (!isSafeHlsStem(stem)) throw new Error('Invalid HLS stem');

  const destDir = path.join(HLS_ROOT, stem);
  const playlist = path.join(destDir, 'index.m3u8');
  const sourceMtime = await mtimeOf(sourcePath);
  const playlistMtime = await mtimeOf(playlist);
  if (sourceMtime !== null && playlistMtime !== null && playlistMtime >= sourceMtime) {
    return playlist;
  }

  const existing = inFlight.get(stem);
  if (existing) return existing;

  const job = generate(sourcePath, stem).finally(() => inFlight.delete(stem));
  inFlight.set(stem, job);
  return job;
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

/** Drops a cached package when its track is deleted. */
export async function removeHlsPackage(stem: string): Promise<void> {
  if (!isSafeHlsStem(stem)) return;
  await fs.promises.rm(path.join(HLS_ROOT, stem), { recursive: true, force: true }).catch(() => {});
}

/** Resolves a track stem to its uploaded audio file, or null when absent. */
export async function resolveTrackSource(stem: string): Promise<string | null> {
  if (!isSafeHlsStem(stem)) return null;
  // The extension is not part of the HLS URL, and uploads keep whatever
  // extension the browser sent, so match against every audio type we accept.
  const wanted = AUDIO_EXTENSIONS.map((ext) => (stem + ext).toLowerCase());
  try {
    const entries = await fs.promises.readdir(TRACKS_ROOT);
    const match = entries.find((entry) => wanted.includes(entry.toLowerCase()));
    if (match) return path.join(TRACKS_ROOT, match);
  } catch {
    return null;
  }
  return null;
}
