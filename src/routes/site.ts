import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { queryAll, queryOne, runSQL, withTransaction } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { browseLimiter, writeLimiter } from '../middleware/rateLimit';
import { cacheGet, cacheSet, cacheDelete } from '../cache/redis';
import { siteReadCacheKeys } from '../lib/cacheKeys';
import { singleString } from '../lib/validate';
import { asyncHandler } from '../lib/asyncHandler';

/**
 * Site content: leadership, photo albums, announcements and events.
 *
 * Public GETs are anonymous and cached for five minutes; every write requires
 * an admin session and drops the cache key it changed, so an edit is visible
 * to visitors within one request. Reads are deliberately shared between the
 * public pages and the admin screens — the admin list is the same rows a
 * visitor sees, which is what makes "what I edited" and "what is published"
 * impossible to let drift apart.
 */
const router = Router();

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const CACHE_TTL = 300;

// Mirrors the VARCHAR column widths. MySQL in strict mode rejects an overflow
// with an opaque 500 rather than a message naming the field.
const MAX_TITLE = 255;
const MAX_QUOTE = 500;
const MAX_ROLE_LABEL = 255;
const MAX_DESCRIPTION_SHORT = 500;
const MAX_DESCRIPTION = 5000;
const MAX_LOCATION = 255;
const MAX_BODY = 10000;
const MAX_CAPTION = 500;

// Bound on rows any list returns: enough for a homepage feed, small enough
// that one request can never materialise an unbounded table.
const MAX_ROWS = 100;
const MAX_PHOTOS_PER_ALBUM = 500;
// 15 MB — the same cap programs.ts uses for covers, so ordinary phone photos
// pass and the frontend's client-side check stays one shared constant.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_ALBUM_FILES = 30;
const MAX_REORDER_IDS = 100;

const ALLOWED_IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.webp'];
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const LEADERS_KEY = 'public:site:leaders';
const ALBUMS_KEY = 'public:site:albums';
const ANNOUNCEMENTS_KEY = 'public:site:announcements';
const EVENTS_KEY = 'public:site:events';

interface LeaderRow {
  id: string;
  name: string;
  title: string;
  quote: string | null;
  role_label: string | null;
  photo: string | null;
  sort_order: number;
}

interface AlbumRow {
  id: string;
  title: string;
  description: string | null;
  created_by: string;
}

interface AlbumPhotoRow {
  id: string;
  album_id: string;
  caption: string | null;
  file_name: string;
}

interface AnnouncementRow {
  id: string;
  title: string;
  body: string | null;
  pinned: number;
}

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
}

/**
 * Image upload into `uploads/<dir>`.
 *
 * The destination function creates the directory on demand instead of assuming
 * it exists: a fresh clone or container has only the directories that were
 * committed, and multer does not create a string destination's directory for
 * you.
 */
function imageUpload(dir: string, maxFiles = 1) {
  const destination = path.join(UPLOADS_ROOT, dir);
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fsSync.mkdirSync(destination, { recursive: true });
        cb(null, destination);
      },
      filename: (_req, file, cb) => {
        cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
      },
    }),
    limits: { fileSize: MAX_PHOTO_BYTES, files: maxFiles },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      // An explicit rejection gives the admin a real error instead of the
      // confusing "no file was attached" that cb(null, false) produces.
      if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext) || !ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
        return cb(new Error('Invalid file type'));
      }
      cb(null, true);
    },
  });
}

const leaderUpload = imageUpload('leaders');
const albumUpload = imageUpload('albums', MAX_ALBUM_FILES);

/** Best-effort removal of a file multer already wrote to disk. */
function removeUpload(dir: string, filename?: string | null) {
  if (filename) {
    fs.unlink(path.join(UPLOADS_ROOT, dir, path.basename(filename))).catch(() => {});
  }
}

/**
 * Normalises the `datetime-local` value an admin form sends into a MySQL
 * DATETIME literal, or null when it is not a parseable date-time.
 *
 * The form sends `YYYY-MM-DDTHH:MM`; the space form is also accepted so a
 * hand-written API call works. Seconds are appended because MySQL's DATETIME
 * accepts them and the column renders them anyway.
 */
function coerceDateTime(value: unknown): string | null {
  const raw = singleString(value);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(raw);
  if (!match) return null;
  const normalized = `${match[1]} ${match[2]}:00`;
  return Number.isNaN(Date.parse(normalized.replace(' ', 'T'))) ? null : normalized;
}

/** A truthy checkbox/field from multipart or JSON: `true`, `1`, `on`, `yes`. */
function coerceBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.toLowerCase());
  return false;
}

/** Read-through cache for the public lists. */
async function cachedList<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
  const cached = await cacheGet<T[]>(key);
  if (cached) return cached;
  const rows = await load();
  await cacheSet(key, rows, CACHE_TTL);
  return rows;
}

async function withPhotos(albums: AlbumRow[]): Promise<Array<AlbumRow & { photos: AlbumPhotoRow[] }>> {
  return Promise.all(
    albums.map(async (album) => ({
      ...album,
      photos: await queryAll<AlbumPhotoRow>(
        'SELECT * FROM album_photos WHERE album_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT ?',
        [album.id, MAX_PHOTOS_PER_ALBUM]
      ),
    }))
  );
}

/** Next append position for a leader's display order. */
async function nextLeaderSort(): Promise<number> {
  const row = await queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM leaders'
  );
  return Number(row?.next ?? 0);
}

/* ------------------------------------------------------------------ *
 * Public reads
 * ------------------------------------------------------------------ */

router.get('/leaders', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const leaders = await cachedList<LeaderRow>(LEADERS_KEY, () =>
    queryAll<LeaderRow>('SELECT * FROM leaders ORDER BY sort_order ASC, created_at ASC LIMIT ?', [MAX_ROWS])
  );
  res.json(leaders);
}));

router.get('/albums', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const albums = await cachedList<AlbumRow & { photos: AlbumPhotoRow[] }>(ALBUMS_KEY, async () =>
    withPhotos(
      await queryAll<AlbumRow>('SELECT * FROM albums ORDER BY created_at DESC LIMIT ?', [MAX_ROWS])
    )
  );
  res.json(albums);
}));

router.get('/announcements', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const announcements = await cachedList<AnnouncementRow>(ANNOUNCEMENTS_KEY, () =>
    queryAll<AnnouncementRow>(
      'SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT ?',
      [MAX_ROWS]
    )
  );
  res.json(announcements);
}));

// Newest event dates first, so upcoming events (which sort above past ones)
// are the ones that survive the limit. The homepage filters to the future.
router.get('/events', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const events = await cachedList<EventRow>(EVENTS_KEY, () =>
    queryAll<EventRow>('SELECT * FROM events ORDER BY starts_at DESC LIMIT ?', [MAX_ROWS])
  );
  res.json(events);
}));

/* ------------------------------------------------------------------ *
 * Leaders
 * ------------------------------------------------------------------ */

// Registered before PUT /leaders/:id so "reorder" is never parsed as an id.
router.put('/leaders/reorder', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req, res: Response) => {
  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  // Each id costs one UPDATE, so an unbounded array monopolises a pool
  // connection for as long as it runs.
  if (ids.length > MAX_REORDER_IDS) {
    return res.status(400).json({ error: `At most ${MAX_REORDER_IDS} leaders can be reordered at once` });
  }
  if (!ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
    return res.status(400).json({ error: 'ids must be non-empty strings' });
  }

  for (let index = 0; index < ids.length; index++) {
    await runSQL('UPDATE leaders SET sort_order = ? WHERE id = ?', [index, ids[index]!]);
  }

  await cacheDelete(...siteReadCacheKeys('leaders'));
  res.json({ message: 'Order updated' });
}));

router.post('/leaders', writeLimiter, authenticate, requireAdmin, leaderUpload.single('photo'), asyncHandler(async (req: AuthRequest, res: Response) => {
  // Every rejection below has to delete the photo multer already wrote,
  // otherwise each failed validation leaks the uploaded file.
  const invalid = (error: string) => {
    removeUpload('leaders', req.file?.filename);
    return res.status(400).json({ error });
  };

  const { name, title, quote, role_label } = req.body ?? {};

  const cleanName = singleString(name);
  if (!cleanName) return invalid('Name is required');
  const cleanTitle = singleString(title);
  if (!cleanTitle) return invalid('Title is required');
  const cleanQuote = singleString(quote);
  const cleanRoleLabel = singleString(role_label);
  for (const [label, value, max] of [
    ['Name', cleanName, MAX_TITLE],
    ['Title', cleanTitle, MAX_TITLE],
    ['Quote', cleanQuote, MAX_QUOTE],
    ['Role label', cleanRoleLabel, MAX_ROLE_LABEL],
  ] as const) {
    if (value && value.length > max) {
      return invalid(`${label} must be ${max} characters or fewer`);
    }
  }

  const id = uuidv4();
  let sortOrder: number;
  try {
    sortOrder = await nextLeaderSort();
    await runSQL(
      'INSERT INTO leaders (id, name, title, quote, role_label, photo, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cleanName, cleanTitle, cleanQuote || null, cleanRoleLabel || null, req.file?.filename ?? null, sortOrder]
    );
  } catch (err) {
    // Multer has already written the photo; without this a failed INSERT
    // orphans it on disk with no row to ever find it by.
    removeUpload('leaders', req.file?.filename);
    throw err;
  }

  // Cache invalidation stays outside the try: the row is committed at this
  // point, so a Redis hiccup must not delete the photo the new row points at.
  await cacheDelete(...siteReadCacheKeys('leaders'));
  res.status(201).json({
    id,
    name: cleanName,
    title: cleanTitle,
    quote: cleanQuote || null,
    role_label: cleanRoleLabel || null,
    photo: req.file?.filename ?? null,
    sort_order: sortOrder,
  });
}));

router.put('/leaders/:id', writeLimiter, authenticate, requireAdmin, leaderUpload.single('photo'), asyncHandler(async (req: AuthRequest, res: Response) => {
  const leader = await queryOne<LeaderRow>('SELECT * FROM leaders WHERE id = ?', [req.params.id]);
  if (!leader) {
    removeUpload('leaders', req.file?.filename);
    return res.status(404).json({ error: 'Leader not found' });
  }

  const { name, title, quote, role_label } = req.body ?? {};

  const cleanName = singleString(name);
  const cleanTitle = singleString(title);
  if (name !== undefined && !cleanName) {
    removeUpload('leaders', req.file?.filename);
    return res.status(400).json({ error: 'Name cannot be empty' });
  }
  if (title !== undefined && !cleanTitle) {
    removeUpload('leaders', req.file?.filename);
    return res.status(400).json({ error: 'Title cannot be empty' });
  }
  const cleanQuote = singleString(quote);
  const cleanRoleLabel = singleString(role_label);
  for (const [label, value, max] of [
    ['Name', cleanName, MAX_TITLE],
    ['Title', cleanTitle, MAX_TITLE],
    ['Quote', cleanQuote, MAX_QUOTE],
    ['Role label', cleanRoleLabel, MAX_ROLE_LABEL],
  ] as const) {
    if (value && value.length > max) {
      removeUpload('leaders', req.file?.filename);
      return res.status(400).json({ error: `${label} must be ${max} characters or fewer` });
    }
  }

  // Absent fields keep their stored value; an explicitly empty quote/role
  // label clears it. A supplied photo replaces the old one, which is then
  // removed from disk.
  const updatedName = cleanName || leader.name;
  const updatedTitle = cleanTitle || leader.title;
  const updatedQuote = quote !== undefined ? (cleanQuote || null) : leader.quote;
  const updatedRoleLabel = role_label !== undefined ? (cleanRoleLabel || null) : leader.role_label;
  const updatedPhoto = req.file ? req.file.filename : leader.photo;

  await runSQL(
    'UPDATE leaders SET name = ?, title = ?, quote = ?, role_label = ?, photo = ? WHERE id = ?',
    [updatedName, updatedTitle, updatedQuote, updatedRoleLabel, updatedPhoto, req.params.id]
  );

  if (req.file) removeUpload('leaders', leader.photo);

  await cacheDelete(...siteReadCacheKeys('leaders'));
  res.json({ message: 'Leader updated' });
}));

router.delete('/leaders/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const leader = await queryOne<LeaderRow>('SELECT * FROM leaders WHERE id = ?', [req.params.id]);
  if (!leader) return res.status(404).json({ error: 'Leader not found' });

  await runSQL('DELETE FROM leaders WHERE id = ?', [req.params.id]);
  removeUpload('leaders', leader.photo);

  await cacheDelete(...siteReadCacheKeys('leaders'));
  res.json({ message: 'Leader deleted' });
}));

/* ------------------------------------------------------------------ *
 * Albums
 * ------------------------------------------------------------------ */

router.post('/albums', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, description } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (!cleanTitle) return res.status(400).json({ error: 'Title is required' });
  if (cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanDescription = singleString(description);
  if (cleanDescription && cleanDescription.length > MAX_DESCRIPTION_SHORT) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_SHORT} characters or fewer` });
  }

  const id = uuidv4();
  await runSQL('INSERT INTO albums (id, title, description, created_by) VALUES (?, ?, ?, ?)',
    [id, cleanTitle, cleanDescription || null, req.user!.id]);

  await cacheDelete(...siteReadCacheKeys('albums'));
  res.status(201).json({ id, title: cleanTitle, description: cleanDescription || null, photos: [] });
}));

router.put('/albums/:id', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const album = await queryOne<AlbumRow>('SELECT * FROM albums WHERE id = ?', [req.params.id]);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const { title, description } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (title !== undefined && !cleanTitle) {
    return res.status(400).json({ error: 'Title cannot be empty' });
  }
  if (cleanTitle && cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanDescription = singleString(description);
  if (cleanDescription && cleanDescription.length > MAX_DESCRIPTION_SHORT) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_SHORT} characters or fewer` });
  }

  await runSQL('UPDATE albums SET title = ?, description = ? WHERE id = ?', [
    cleanTitle || album.title,
    description !== undefined ? (cleanDescription || null) : album.description,
    req.params.id,
  ]);

  await cacheDelete(...siteReadCacheKeys('albums'));
  res.json({ message: 'Album updated' });
}));

router.delete('/albums/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const album = await queryOne<AlbumRow>('SELECT * FROM albums WHERE id = ?', [req.params.id]);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const photos = await queryAll<{ file_name: string }>(
    'SELECT file_name FROM album_photos WHERE album_id = ?',
    [req.params.id]
  );

  // Photos cascade with the row; only the files on disk need explicit cleanup.
  await runSQL('DELETE FROM albums WHERE id = ?', [req.params.id]);
  for (const photo of photos) removeUpload('albums', photo.file_name);

  await cacheDelete(...siteReadCacheKeys('albums'));
  res.json({ message: 'Album deleted' });
}));

router.post('/albums/:id/photos', writeLimiter, authenticate, requireAdmin, albumUpload.array('photos', MAX_ALBUM_FILES), asyncHandler(async (req: AuthRequest, res: Response) => {
  // Captured immediately: multer has already written every file by the time
  // the handler runs, so every early return has to delete them or a rejected
  // batch leaks up to 30 images.
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const reject = (status: number, error: string) => {
    for (const file of files) removeUpload('albums', file.filename);
    return res.status(status).json({ error });
  };

  if (files.length === 0) return reject(400, 'No photos provided');

  const album = await queryOne<AlbumRow>('SELECT * FROM albums WHERE id = ?', [req.params.id]);
  if (!album) return reject(404, 'Album not found');

  // Repeated `captions` fields arrive as an array; a single one arrives as a
  // string. Normalise both to an array so index i belongs to file i.
  const rawCaptions = req.body?.captions;
  const captions: unknown[] = rawCaptions === undefined ? [] : Array.isArray(rawCaptions) ? rawCaptions : [rawCaptions];
  if (captions.some((c) => typeof c === 'string' && c.length > MAX_CAPTION)) {
    return reject(400, `Caption must be ${MAX_CAPTION} characters or fewer`);
  }

  const position = await queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM album_photos WHERE album_id = ?',
    [album.id]
  );
  let sortOrder = Number(position?.next ?? 0);

  try {
    // One transaction for the whole batch: without it, a failure on photo 7 of
    // 10 would leave six committed rows pointing at files this handler is
    // about to delete, with no request ever able to reach them again.
    await withTransaction(async (conn) => {
      for (const [index, file] of files.entries()) {
        const caption = singleString(captions[index]) || null;
        await conn.execute(
          'INSERT INTO album_photos (id, album_id, caption, file_name, sort_order) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), album.id, caption, file.filename, sortOrder]
        );
        sortOrder++;
      }
    });
  } catch (err) {
    // The transaction rolled back every row, so the files on disk are now
    // unreachable — remove them before surfacing the error.
    for (const file of files) removeUpload('albums', file.filename);
    throw err;
  }

  await cacheDelete(...siteReadCacheKeys('albums'));
  res.status(201).json({ uploaded: files.length });
}));

router.delete('/albums/:albumId/photos/:photoId', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const photo = await queryOne<AlbumPhotoRow>(
    'SELECT * FROM album_photos WHERE id = ? AND album_id = ?',
    [req.params.photoId, req.params.albumId]
  );
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  await runSQL('DELETE FROM album_photos WHERE id = ?', [req.params.photoId]);
  removeUpload('albums', photo.file_name);

  await cacheDelete(...siteReadCacheKeys('albums'));
  res.json({ message: 'Photo deleted' });
}));

/* ------------------------------------------------------------------ *
 * Announcements
 * ------------------------------------------------------------------ */

router.post('/announcements', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, body, pinned } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (!cleanTitle) return res.status(400).json({ error: 'Title is required' });
  if (cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanBody = singleString(body);
  if (cleanBody && cleanBody.length > MAX_BODY) {
    return res.status(400).json({ error: `Body must be ${MAX_BODY} characters or fewer` });
  }

  const id = uuidv4();
  const isPinned = coerceBool(pinned) ? 1 : 0;
  await runSQL('INSERT INTO announcements (id, title, body, pinned, created_by) VALUES (?, ?, ?, ?, ?)',
    [id, cleanTitle, cleanBody || null, isPinned, req.user!.id]);

  await cacheDelete(...siteReadCacheKeys('announcements'));
  res.status(201).json({ id, title: cleanTitle, body: cleanBody || null, pinned: isPinned });
}));

router.put('/announcements/:id', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const announcement = await queryOne<AnnouncementRow>('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  const { title, body, pinned } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (title !== undefined && !cleanTitle) {
    return res.status(400).json({ error: 'Title cannot be empty' });
  }
  if (cleanTitle && cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanBody = singleString(body);
  if (cleanBody && cleanBody.length > MAX_BODY) {
    return res.status(400).json({ error: `Body must be ${MAX_BODY} characters or fewer` });
  }

  await runSQL('UPDATE announcements SET title = ?, body = ?, pinned = ? WHERE id = ?', [
    cleanTitle || announcement.title,
    body !== undefined ? (cleanBody || null) : announcement.body,
    pinned !== undefined ? (coerceBool(pinned) ? 1 : 0) : announcement.pinned,
    req.params.id,
  ]);

  await cacheDelete(...siteReadCacheKeys('announcements'));
  res.json({ message: 'Announcement updated' });
}));

router.delete('/announcements/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const announcement = await queryOne<AnnouncementRow>('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  await runSQL('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  await cacheDelete(...siteReadCacheKeys('announcements'));
  res.json({ message: 'Announcement deleted' });
}));

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

router.post('/events', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const { title, description, location, starts_at, ends_at } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (!cleanTitle) return res.status(400).json({ error: 'Title is required' });
  if (cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanDescription = singleString(description);
  if (cleanDescription && cleanDescription.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION} characters or fewer` });
  }
  const cleanLocation = singleString(location);
  if (cleanLocation && cleanLocation.length > MAX_LOCATION) {
    return res.status(400).json({ error: `Location must be ${MAX_LOCATION} characters or fewer` });
  }

  const start = coerceDateTime(starts_at);
  if (!start) return res.status(400).json({ error: 'A valid start date and time is required' });
  const end = ends_at !== undefined && singleString(ends_at) ? coerceDateTime(ends_at) : null;
  if (ends_at !== undefined && singleString(ends_at) && !end) {
    return res.status(400).json({ error: 'Invalid end date and time' });
  }
  if (end && end < start) {
    return res.status(400).json({ error: 'End must be after start' });
  }

  const id = uuidv4();
  await runSQL(
    'INSERT INTO events (id, title, description, location, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, cleanTitle, cleanDescription || null, cleanLocation || null, start, end, req.user!.id]
  );

  await cacheDelete(...siteReadCacheKeys('events'));
  res.status(201).json({
    id, title: cleanTitle, description: cleanDescription || null,
    location: cleanLocation || null, starts_at: start, ends_at: end,
  });
}));

router.put('/events/:id', writeLimiter, authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res: Response) => {
  const event = await queryOne<EventRow>('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { title, description, location, starts_at, ends_at } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (title !== undefined && !cleanTitle) {
    return res.status(400).json({ error: 'Title cannot be empty' });
  }
  if (cleanTitle && cleanTitle.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  const cleanDescription = singleString(description);
  if (cleanDescription && cleanDescription.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION} characters or fewer` });
  }
  const cleanLocation = singleString(location);
  if (cleanLocation && cleanLocation.length > MAX_LOCATION) {
    return res.status(400).json({ error: `Location must be ${MAX_LOCATION} characters or fewer` });
  }

  const start = starts_at !== undefined ? coerceDateTime(starts_at) : event.starts_at;
  if (!start) return res.status(400).json({ error: 'Invalid start date and time' });

  let end: string | null;
  if (ends_at !== undefined) {
    end = singleString(ends_at) ? coerceDateTime(ends_at) : null;
    if (singleString(ends_at) && !end) {
      return res.status(400).json({ error: 'Invalid end date and time' });
    }
  } else {
    end = event.ends_at;
  }
  if (end && end < start) {
    return res.status(400).json({ error: 'End must be after start' });
  }

  await runSQL('UPDATE events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ? WHERE id = ?', [
    cleanTitle || event.title,
    description !== undefined ? (cleanDescription || null) : event.description,
    location !== undefined ? (cleanLocation || null) : event.location,
    start,
    end,
    req.params.id,
  ]);

  await cacheDelete(...siteReadCacheKeys('events'));
  res.json({ message: 'Event updated' });
}));

router.delete('/events/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const event = await queryOne<EventRow>('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  await runSQL('DELETE FROM events WHERE id = ?', [req.params.id]);
  await cacheDelete(...siteReadCacheKeys('events'));
  res.json({ message: 'Event deleted' });
}));

export default router;
