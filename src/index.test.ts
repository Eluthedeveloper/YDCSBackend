import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from './index';

// audio/* and image/* are not text, so superagent leaves res.body empty unless
// a parser is supplied.
const asBuffer = (res: request.Response) =>
  Buffer.isBuffer(res.body) ? res.body.toString('utf8') : (res.text ?? '');

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const AUDIO_DIR = path.join(UPLOADS_ROOT, 'tracks');
const COVER_DIR = path.join(UPLOADS_ROOT, 'covers');

const NAMES: string[] = [];

function writeFixture(dir: string, name: string, contents: string) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, contents);
  NAMES.push(full);
  return full;
}

// Byte i is a distinct, position-dependent character, so a range response can
// be checked for *which* bytes it returned. vitest-audio.mp3 is a single
// repeated glyph and cannot distinguish the start of the file from the end.
const POSITIONED = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');

beforeAll(() => {
  writeFixture(AUDIO_DIR, 'vitest-audio.mp3', 'A'.repeat(1000));
  writeFixture(AUDIO_DIR, 'vitest-positioned.mp3', POSITIONED);
  writeFixture(COVER_DIR, 'vitest-cover.png', 'B'.repeat(500));
});

afterAll(() => {
  for (const f of NAMES) fs.rmSync(f, { force: true });
});

describe('GET /api/uploads/:type/:filename', () => {
  const { app } = createApp();

  // Declaring Content-Length without piping the bytes leaves the client
  // waiting for a body that never arrives, so the full-file case has to stream
  // too rather than just calling end().
  it('serves a known audio file with the right content type', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000');
    expect(asBuffer(res)).toHaveLength(1000);
  });

  // Without this, IDM and similar download managers offer to capture every
  // track the player streams.
  it('declares the file inline so download managers do not capture it', async () => {
    const res = await request(app).get('/api/uploads/tracks/vitest-audio.mp3');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline');
  });

  it('sends the inline disposition on range responses too', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .set('Range', 'bytes=0-9');

    expect(res.status).toBe(206);
    expect(res.headers['content-disposition']).toBe('inline');
  });

  it('honours a byte range so audio seeking works', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .set('Range', 'bytes=0-9')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-9/1000');
    expect(res.headers['content-length']).toBe('10');
    expect(asBuffer(res)).toBe('A'.repeat(10));
  });

  it('clamps an over-long range end to the file size', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .set('Range', 'bytes=990-99999');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 990-999/1000');
  });

  // `bytes=-N` means the LAST N bytes. Reading the suffix as an absolute end
  // offset served the first N bytes instead, which returned the right length
  // from entirely the wrong part of the file.
  it('treats a suffix range as the last N bytes, not the first N', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-positioned.mp3')
      .set('Range', 'bytes=-10')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 990-999/1000');
    expect(res.headers['content-length']).toBe('10');
    expect(asBuffer(res)).toBe(POSITIONED.slice(990));
  });

  it('clamps a suffix longer than the file to the whole file', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-positioned.mp3')
      .set('Range', 'bytes=-5000');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-999/1000');
  });

  it('returns 416 for an open-ended range with no start', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-positioned.mp3')
      .set('Range', 'bytes=-');

    expect(res.status).toBe(416);
  });

  it('returns 416 for a start past the end of the file', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .set('Range', 'bytes=5000-6000');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
  });

  it('rejects a multi-range request instead of silently sending the whole file', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.mp3')
      .set('Range', 'bytes=0-9,20-29');

    expect(res.status).toBe(416);
  });

  it('rejects an unknown upload type', async () => {
    const res = await request(app).get('/api/uploads/secrets/vitest-audio.mp3');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a file that does not exist', async () => {
    const res = await request(app).get('/api/uploads/tracks/definitely-not-here.mp3');
    expect(res.status).toBe(404);
  });

  // The player streams from `<uuid>.stream` so IDM has no file extension to
  // build a download task around. The stem has to resolve back to the real file
  // on disk, and the response must stay byte-range capable for seeking. The
  // declared type is deliberately neutral (not `audio/*`) so a download manager
  // sniffing Content-Type has no media type to name a capture after; the
  // browser decodes the audio from the bytes regardless.
  it('resolves an extensionless .stream name back to the audio file', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-audio.stream')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(asBuffer(res)).toBe('A'.repeat(1000));
  });

  it('still honours byte ranges on a .stream URL so seeking works', async () => {
    const res = await request(app)
      .get('/api/uploads/tracks/vitest-positioned.stream')
      .set('Range', 'bytes=990-999')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 990-999/1000');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(asBuffer(res)).toBe(POSITIONED.slice(990));
  });

  it('matches a .stream stem case-insensitively, since uploads keep their original extension case', async () => {
    writeFixture(AUDIO_DIR, 'vitest-shouty.MP3', 'C'.repeat(50));

    const res = await request(app).get('/api/uploads/tracks/vitest-shouty.stream');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('returns 404 for a .stream stem with no matching file', async () => {
    const res = await request(app).get('/api/uploads/tracks/definitely-not-here.stream');
    expect(res.status).toBe(404);
  });

  // A cover image requested through .stream must not resolve, since resolving
  // only ever appends the audio extensions. This is what keeps the resolver from
  // turning into a general "find any file with this stem" lookup.
  it('does not resolve a .stream name to a non-audio file', async () => {
    const res = await request(app).get('/api/uploads/covers/vitest-cover.stream');
    expect(res.status).toBe(404);
  });

  it('does not treat a directory as a downloadable file', async () => {
    // uploads/tracks is a real directory; serving it would leak a listing.
    const res = await request(app).get('/api/uploads/tracks');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // The traversal guard used to be `filePath.startsWith(resolve(root, type))`,
  // which a sibling directory named `tracks-backup` satisfies as a string
  // prefix. basename() already collapses the path, so this asserts the resolved
  // file's parent is exactly the expected directory.
  it.each([
    ['..%2F..%2Fpackage.json', 'encoded parent traversal'],
    ['....//package.json', 'dot-segment traversal'],
    ['%2e%2e%2f%2e%2e%2f.env', 'encoded dot-dot to the repo root'],
  ])('refuses %s (%s)', async (filename) => {
    const res = await request(app).get(`/api/uploads/tracks/${filename}`);
    expect([403, 404]).toContain(res.status);
    expect(res.text).not.toMatch(/MYSQL_ROOT_PASSWORD|"name": "audiostreaming-backend"/);
  });
});

describe('GET /health', () => {
  const { app } = createApp();

  it('reports healthy without touching the database', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });
});

describe('unknown routes', () => {
  const { app } = createApp();

  it('returns a JSON 404 rather than the express HTML default', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Route not found' });
  });
});
