import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { queryAll, queryOne, runSQL, withTransaction } from '../database/schema';
import { AuthRequest, authenticate, requireSuperAdmin, requireAdmin } from '../middleware/auth';
import { browseLimiter, writeLimiter, uploadLimiter } from '../middleware/rateLimit';
import { cacheGet, cacheSet, cacheDelete } from '../cache/redis';
import { siteReadCacheKeys, feedReadCacheKeys } from '../lib/cacheKeys';
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
const MAX_EXCERPT = 500;
const MAX_CATEGORY = 100;
// MEDIUMTEXT would hold far more, but a 50k-character wall of text is past
// what anyone reads on a card-driven blog; the cap keeps posts scannable.
const MAX_BLOG_BODY = 50000;
// Extra photos inside an article. Six is the point where a grid still fits
// one screen on a phone without turning the post into a gallery page.
const MAX_BLOG_IMAGES = 6;

// Bound on rows any list returns: enough for a homepage feed, small enough
// that one request can never materialise an unbounded table.
const MAX_ROWS = 100;
const MAX_PHOTOS_PER_ALBUM = 500;
// 15 MB — the same cap programs.ts uses for covers, so ordinary phone photos
// pass and the frontend's client-side check stays one shared constant.
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_ALBUM_FILES = 30;
const MAX_REORDER_IDS = 100;
// Rows pulled from each table to build the feed, and how many merged entries
// survive the sort. Both are small on purpose: the bell renders a dropdown,
// not a page.
const FEED_ROWS = 8;
const FEED_LIMIT = 12;

const ALLOWED_IMAGE_EXTENSIONS = ['.jpeg', '.jpg', '.png', '.webp'];
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const LEADERS_KEY = 'public:site:leaders';
const ALBUMS_KEY = 'public:site:albums';
const ANNOUNCEMENTS_KEY = 'public:site:announcements';
const EVENTS_KEY = 'public:site:events';
const BLOG_KEY = 'public:site:blog';
const WHATS_NEW_KEY = 'public:site:whats-new';
// Short enough that a freshly posted announcement reaches the bell within a
// minute, long enough that the polling tab does not turn every 60 s into a
// three-way query.
const WHATS_NEW_TTL = 60;

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

interface BlogRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  category: string | null;
  cover_image: string | null;
  published: number;
  created_at?: string;
  updated_at?: string;
}

/** One extra photo attached to a blog post, after the cover. */
interface BlogImageRow {
  id: string;
  blog_post_id: string;
  image: string;
  sort_order: number;
  created_at?: string;
}

/** One row of the merged "what's new" feed the notification bell polls. */
interface WhatsNewItem {
  id: string;
  type: 'blog' | 'announcement' | 'event';
  title: string;
  summary: string | null;
  image: string | null;
  url: string;
  published_at: string;
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
// One multer instance serves both fields: the cover is a single file and the
// gallery is an array, and they share the destination, size cap and filter.
const blogUpload = imageUpload('blogs', 1 + MAX_BLOG_IMAGES);

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

/**
 * URL-safe form of a title for the post's permanent link.
 *
 * Diacritics are stripped rather than dropped so an Amharic-free English
 * title keeps its accents, and a title that is nothing but punctuation still
 * yields a usable slug instead of an empty string that the UNIQUE index
 * would reject on the second such post.
 */
function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return base || 'post';
}

/** A slug no other row holds, so slugs stay unique without a retry loop at read time. */
async function uniqueSlug(title: string, excludeId?: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  for (let suffix = 2; suffix < 50; suffix++) {
    const clash = await queryOne<{ id: string }>('SELECT id FROM blog_posts WHERE slug = ?', [candidate]);
    if (!clash || clash.id === excludeId) return candidate;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${uuidv4().slice(0, 8)}`;
}

/** Fallback excerpt when an admin left the field blank. */
function deriveExcerpt(post: { excerpt?: string | null; body?: string | null }): string | null {
  const explicit = (post.excerpt ?? '').trim();
  if (explicit) return explicit;
  const text = (post.body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

/** One-line teaser for a feed row, so a long announcement cannot wrap the bell. */
function summarize(text: string | null | undefined, max = 160): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
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

/** Attaches each post's extra photos, in the order the article shows them. */
async function withBlogImages(posts: BlogRow[]): Promise<Array<BlogRow & { images: string[] }>> {
  return Promise.all(
    posts.map(async (post) => {
      const rows = await queryAll<BlogImageRow>(
        'SELECT image FROM blog_images WHERE blog_post_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT ?',
        [post.id, MAX_BLOG_IMAGES]
      );
      return { ...post, images: rows.map((row) => row.image) };
    })
  );
}

/**
 * Normalises the `keepImages` body field of an edit: a JSON array of the
 * gallery filenames the admin did not remove. Basenames only, so a crafted
 * value can never match a row by path trickery.
 */
function parseKeepImages(raw: unknown): string[] {
  const parsed: unknown = typeof raw === 'string' && raw.trim().startsWith('[')
    ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
    : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => path.basename(value));
}

/**
 * Replaces a post's gallery in one transaction: rows the admin dropped are
 * deleted (and their files unlinked), new uploads are appended after the
 * survivors. The caller checks the combined count first, so this helper can
 * assume it stays inside MAX_BLOG_IMAGES.
 */
async function syncBlogImages(
  postId: string,
  existing: BlogImageRow[],
  keepNames: string[],
  newFiles: Express.Multer.File[]
): Promise<void> {
  const kept = existing.filter((row) => keepNames.includes(row.image));
  const dropped = existing.filter((row) => !keepNames.includes(row.image));
  let sortOrder = kept.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;

  // One transaction for the whole batch: without it, a failure on photo 3 of
  // 5 would leave earlier rows committed while their files are about to be
  // deleted, producing rows nothing on disk can satisfy.
  try {
    await withTransaction(async (conn) => {
      for (const row of dropped) {
        await conn.execute('DELETE FROM blog_images WHERE id = ?', [row.id]);
      }
      for (const file of newFiles) {
        await conn.execute(
          'INSERT INTO blog_images (id, blog_post_id, image, sort_order) VALUES (?, ?, ?, ?)',
          [uuidv4(), postId, file.filename, sortOrder++]
        );
      }
    });
  } catch (err) {
    // The transaction rolled back every row, so the new files on disk are
    // unreachable — remove them before surfacing the error.
    for (const file of newFiles) removeUpload('blogs', file.filename);
    throw err;
  }

  for (const row of dropped) removeUpload('blogs', row.image);
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
 * Blog
 * ------------------------------------------------------------------ */

// Published posts only: the list is the public feed, and a draft must not
// leak through a cached response just because an admin previewed it once.
router.get('/blog', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const posts = await cachedList(BLOG_KEY, async () =>
    withBlogImages(
      await queryAll<BlogRow>(
        'SELECT id, slug, title, excerpt, category, cover_image, published, created_at, updated_at ' +
          'FROM blog_posts WHERE published = 1 ORDER BY created_at DESC LIMIT ?',
        [MAX_ROWS]
      )
    )
  );
  res.json(posts);
}));

// Registered before /blog/:slug so "admin" is never parsed as a slug.
router.get('/blog/admin', authenticate, requireAdmin, asyncHandler(async (_req, res: Response) => {
  const posts = await withBlogImages(
    await queryAll<BlogRow>('SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT ?', [MAX_ROWS])
  );
  res.json(posts);
}));

router.get('/blog/:slug', browseLimiter, asyncHandler(async (req, res: Response) => {
  const post = await queryOne<BlogRow>('SELECT * FROM blog_posts WHERE slug = ? AND published = 1', [
    String(req.params.slug),
  ]);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json((await withBlogImages([post]))[0]);
}));

/**
 * Merged recency feed behind the notification bell: the newest blog posts,
 * announcements and events in one list, so the client polls one endpoint
 * instead of three and the blink logic compares a single timestamp.
 */
router.get('/whats-new', browseLimiter, asyncHandler(async (_req, res: Response) => {
  const cached = await cacheGet<WhatsNewItem[]>(WHATS_NEW_KEY);
  if (cached) return res.json(cached);

  const [posts, announcements, events] = await Promise.all([
    queryAll<{ id: string; slug: string; title: string; excerpt: string | null; body: string | null; cover_image: string | null; created_at: string }>(
      'SELECT id, slug, title, excerpt, body, cover_image, created_at FROM blog_posts WHERE published = 1 ORDER BY created_at DESC LIMIT ?',
      [FEED_ROWS]
    ),
    queryAll<{ id: string; title: string; body: string | null; created_at: string }>(
      'SELECT id, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT ?',
      [FEED_ROWS]
    ),
    queryAll<{ id: string; title: string; description: string | null; location: string | null; created_at: string }>(
      'SELECT id, title, description, location, created_at FROM events ORDER BY created_at DESC LIMIT ?',
      [FEED_ROWS]
    ),
  ]);

  const items: WhatsNewItem[] = [
    ...posts.map((post) => ({
      id: post.id,
      type: 'blog' as const,
      title: post.title,
      summary: deriveExcerpt({ excerpt: post.excerpt, body: post.body }),
      image: post.cover_image,
      url: `/blog/${post.slug}`,
      published_at: post.created_at,
    })),
    ...announcements.map((row) => ({
      id: row.id,
      type: 'announcement' as const,
      title: row.title,
      summary: summarize(row.body),
      image: null,
      url: '/',
      published_at: row.created_at,
    })),
    ...events.map((row) => ({
      id: row.id,
      type: 'event' as const,
      title: row.title,
      summary: summarize(row.location ? `${row.location} — ${row.description ?? ''}` : row.description),
      image: null,
      url: '/',
      published_at: row.created_at,
    })),
  ];

  items.sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));
  const feed = items.slice(0, FEED_LIMIT);
  await cacheSet(WHATS_NEW_KEY, feed, WHATS_NEW_TTL);
  res.json(feed);
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

router.post('/leaders', authenticate, requireAdmin, uploadLimiter, leaderUpload.single('photo'), asyncHandler(async (req: AuthRequest, res: Response) => {
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

router.put('/leaders/:id', authenticate, requireAdmin, uploadLimiter, leaderUpload.single('photo'), asyncHandler(async (req: AuthRequest, res: Response) => {
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

router.post('/albums/:id/photos', authenticate, requireAdmin, uploadLimiter, albumUpload.array('photos', MAX_ALBUM_FILES), asyncHandler(async (req: AuthRequest, res: Response) => {
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

  await cacheDelete(...feedReadCacheKeys('announcements'));
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

  await cacheDelete(...feedReadCacheKeys('announcements'));
  res.json({ message: 'Announcement updated' });
}));

router.delete('/announcements/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const announcement = await queryOne<AnnouncementRow>('SELECT * FROM announcements WHERE id = ?', [req.params.id]);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });

  await runSQL('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  await cacheDelete(...feedReadCacheKeys('announcements'));
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

  await cacheDelete(...feedReadCacheKeys('events'));
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

  await cacheDelete(...feedReadCacheKeys('events'));
  res.json({ message: 'Event updated' });
}));

router.delete('/events/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const event = await queryOne<EventRow>('SELECT * FROM events WHERE id = ?', [req.params.id]);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  await runSQL('DELETE FROM events WHERE id = ?', [req.params.id]);
  await cacheDelete(...feedReadCacheKeys('events'));
  res.json({ message: 'Event deleted' });
}));

/* ------------------------------------------------------------------ *
 * Blog posts
 * ------------------------------------------------------------------ */

/** Reads the two upload fields multer's `fields()` middleware populated. */
function blogUploadFields(req: AuthRequest): { cover?: Express.Multer.File; gallery: Express.Multer.File[] } {
  const files = (req.files as Record<string, Express.Multer.File[] | undefined> | undefined) ?? {};
  return { cover: files.cover?.[0], gallery: files.images ?? [] };
}

router.post('/blog', writeLimiter, authenticate, requireAdmin, uploadLimiter, blogUpload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'images', maxCount: MAX_BLOG_IMAGES },
]), asyncHandler(async (req: AuthRequest, res: Response) => {
  // Multer has already written every file by the time the handler runs, so
  // every rejection below has to delete all of them or the failed request
  // leaks the cover and up to six gallery photos.
  const { cover, gallery } = blogUploadFields(req);
  const invalid = (error: string) => {
    removeUpload('blogs', cover?.filename);
    for (const file of gallery) removeUpload('blogs', file.filename);
    return res.status(400).json({ error });
  };

  const { title, excerpt, body, category, published } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (!cleanTitle) return invalid('Title is required');
  const cleanExcerpt = singleString(excerpt);
  const cleanBody = singleString(body);
  const cleanCategory = singleString(category);
  for (const [label, value, max] of [
    ['Title', cleanTitle, MAX_TITLE],
    ['Excerpt', cleanExcerpt, MAX_EXCERPT],
    ['Body', cleanBody, MAX_BLOG_BODY],
    ['Category', cleanCategory, MAX_CATEGORY],
  ] as const) {
    if (value && value.length > max) return invalid(`${label} must be ${max} characters or fewer`);
  }
  if (gallery.length > MAX_BLOG_IMAGES) {
    return invalid(`A post can hold at most ${MAX_BLOG_IMAGES} photos`);
  }
  // The excerpt is what every card and feed row shows; deriving it from the
  // body keeps the public list complete even when the field was skipped.
  const storedExcerpt = cleanExcerpt || deriveExcerpt({ body: cleanBody });
  // An absent flag means publish: the admin form always sends one, so only an
  // explicit false/0 keeps a post off the public site.
  const isPublished = published === undefined ? 1 : coerceBool(published) ? 1 : 0;

  const id = uuidv4();
  let slug: string;
  try {
    slug = await uniqueSlug(cleanTitle);
    await runSQL(
      'INSERT INTO blog_posts (id, slug, title, excerpt, body, category, cover_image, published, created_by) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, slug, cleanTitle, storedExcerpt, cleanBody || null, cleanCategory || null,
       cover?.filename ?? null, isPublished, req.user!.id]
    );
    await syncBlogImages(id, [], [], gallery);
  } catch (err) {
    // Multer has already written the cover; without this a failed INSERT
    // orphans it on disk with no row to ever find it by.
    removeUpload('blogs', cover?.filename);
    throw err;
  }

  await cacheDelete(...feedReadCacheKeys('blog'));
  res.status(201).json({
    id, slug, title: cleanTitle, excerpt: storedExcerpt, body: cleanBody || null,
    category: cleanCategory || null, cover_image: cover?.filename ?? null,
    images: gallery.map((file) => file.filename), published: isPublished,
  });
}));

router.put('/blog/:id', writeLimiter, authenticate, requireAdmin, uploadLimiter, blogUpload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'images', maxCount: MAX_BLOG_IMAGES },
]), asyncHandler(async (req: AuthRequest, res: Response) => {
  const { cover, gallery } = blogUploadFields(req);
  const reject = (status: number, error: string) => {
    removeUpload('blogs', cover?.filename);
    for (const file of gallery) removeUpload('blogs', file.filename);
    return res.status(status).json({ error });
  };

  const post = await queryOne<BlogRow>('SELECT * FROM blog_posts WHERE id = ?', [req.params.id]);
  if (!post) return reject(404, 'Post not found');

  const { title, excerpt, body, category, published } = req.body ?? {};

  const cleanTitle = singleString(title);
  if (title !== undefined && !cleanTitle) return reject(400, 'Title cannot be empty');
  const cleanExcerpt = singleString(excerpt);
  const cleanBody = singleString(body);
  const cleanCategory = singleString(category);
  for (const [label, value, max] of [
    ['Title', cleanTitle, MAX_TITLE],
    ['Excerpt', cleanExcerpt, MAX_EXCERPT],
    ['Body', cleanBody, MAX_BLOG_BODY],
    ['Category', cleanCategory, MAX_CATEGORY],
  ] as const) {
    if (value && value.length > max) return reject(400, `${label} must be ${max} characters or fewer`);
  }

  const existing = await queryAll<BlogImageRow>(
    'SELECT * FROM blog_images WHERE blog_post_id = ? ORDER BY sort_order ASC',
    [req.params.id]
  );
  // A request without `keepImages` (an API client rather than the admin form)
  // leaves the gallery untouched; the form always lists what survives.
  const keepNames = req.body?.keepImages === undefined
    ? existing.map((row) => row.image)
    : parseKeepImages(req.body.keepImages);
  const keptCount = existing.filter((row) => keepNames.includes(row.image)).length;
  if (keptCount + gallery.length > MAX_BLOG_IMAGES) {
    return reject(400, `A post can hold at most ${MAX_BLOG_IMAGES} photos`);
  }

  // The slug is deliberately never rewritten: it is the post's permanent
  // link, and an edit to the title must not break every URL already shared.
  const updatedTitle = cleanTitle || post.title;
  const nextBody = body !== undefined ? (cleanBody || null) : post.body;
  const nextExcerpt = excerpt !== undefined
    ? (cleanExcerpt || deriveExcerpt({ body: nextBody }))
    : (cleanExcerpt ? cleanExcerpt : post.excerpt);
  const nextCover = cover ? cover.filename : post.cover_image;

  await runSQL(
    'UPDATE blog_posts SET title = ?, excerpt = ?, body = ?, category = ?, cover_image = ?, published = ? WHERE id = ?',
    [
      updatedTitle,
      nextExcerpt,
      nextBody,
      category !== undefined ? (cleanCategory || null) : post.category,
      nextCover,
      published !== undefined ? (coerceBool(published) ? 1 : 0) : post.published,
      req.params.id,
    ]
  );

  await syncBlogImages(post.id, existing, keepNames, gallery);

  if (cover) removeUpload('blogs', post.cover_image);

  await cacheDelete(...feedReadCacheKeys('blog'));
  res.json({ message: 'Post updated' });
}));

router.delete('/blog/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res) => {
  const post = await queryOne<BlogRow>('SELECT * FROM blog_posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const images = await queryAll<BlogImageRow>('SELECT image FROM blog_images WHERE blog_post_id = ?', [
    post.id,
  ]);

  // The rows go with the post (ON DELETE CASCADE); the files have no such
  // luck and have to be unlinked by hand.
  await runSQL('DELETE FROM blog_posts WHERE id = ?', [req.params.id]);
  removeUpload('blogs', post.cover_image);
  for (const row of images) removeUpload('blogs', row.image);

  await cacheDelete(...feedReadCacheKeys('blog'));
  res.json({ message: 'Post deleted' });
}));

router.delete('/blog/:id', writeLimiter, authenticate, requireSuperAdmin, asyncHandler(async (req, res: Response) => {
  const post = await queryOne<BlogRow>('SELECT * FROM blog_posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  await runSQL('DELETE FROM blog_posts WHERE id = ?', [req.params.id]);
  removeUpload('blogs', post.cover_image);

  await cacheDelete(...feedReadCacheKeys('blog'));
  res.json({ message: 'Post deleted' });
}));

export default router;
