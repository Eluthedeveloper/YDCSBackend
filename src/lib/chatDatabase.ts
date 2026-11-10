import { queryAll, queryOne } from '../database/schema';

/**
 * Read-only database tools for the visitor assistant.
 *
 * The assistant may look at live public content (programmes, tracks, published
 * articles, announcements, events, leaders, albums and counts) but must never
 * reach private data. Two rules enforce that:
 *
 * 1. Every query in this file is written out in full. The model supplies only
 *    bound `?` parameters, never a table name, column name, ORDER BY or SQL
 *    fragment, so a prompt injection cannot turn a search into `SELECT * FROM
 *    users`.
 * 2. Results are mapped through the small shapes below. Even if a future edit
 *    widens a SELECT, `created_by`, `file_path`, emails and password hashes have
 *    no path into a tool response.
 *
 * `users`, `comments`, `likes`, `listens`, `blog_images` and `schema_migrations`
 * are deliberately absent: they hold account, personal or analytics data that a
 * website visitor has no business reading through a chatbot.
 */

export interface ChatToolDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, {
      type: 'STRING';
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface ChatFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

export type ChatToolResult = { output: unknown } | { error: string };

const MAX_PROGRAMS = 6;
const MAX_TRACKS = 8;
const MAX_ARTICLES = 5;
const MAX_ANNOUNCEMENTS = 6;
const MAX_EVENTS = 8;
const MAX_LEADERS = 20;
const MAX_ALBUMS = 10;
const MAX_QUERY_CHARS = 100;

// Escaping the wildcards stops a visitor's `%` or `_` from turning a keyword
// search into a whole-table dump. `!` is used as the escape character rather
// than a backslash so the behaviour does not depend on MySQL's
// NO_BACKSLASH_ESCAPES mode.
const LIKE_ESCAPE = "ESCAPE '!'";

export const CHAT_TOOL_DECLARATIONS: ChatToolDeclaration[] = [
  {
    name: 'search_programs',
    description:
      'Search the public programme library by title or description. Use short keywords, a name or a topic. Omit the query to list the newest programmes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Optional short search term, for example "prayer" or "family".',
        },
      },
    },
  },
  {
    name: 'search_tracks',
    description:
      'Search recorded tracks by title, artist, album or parent programme. Use short keywords. Omit the query to list the newest tracks. Duration is in seconds.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Optional short search term, for example an artist or song title.',
        },
      },
    },
  },
  {
    name: 'search_blog_posts',
    description:
      'Search published blog articles and news by title, excerpt, category or body text. Only published articles are visible. Omit the query to list the newest articles.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Optional short search term or topic.',
        },
      },
    },
  },
  {
    name: 'list_announcements',
    description:
      'List recent public announcements from the website, newest and pinned first.',
  },
  {
    name: 'list_events',
    description:
      'List public events with their dates and locations. Defaults to upcoming events; use scope "past" or "all" when the visitor asks about previous or all events.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: {
          type: 'STRING',
          description: 'Which events to return.',
          enum: ['upcoming', 'past', 'all'],
        },
      },
    },
  },
  {
    name: 'list_leaders',
    description:
      'List the public leadership team with names, titles, role labels and short quotes.',
  },
  {
    name: 'list_albums',
    description:
      'List public photo albums with their titles, descriptions, dates and photo counts.',
  },
  {
    name: 'get_content_stats',
    description:
      'Get public counts of programmes, tracks, published articles, announcements, upcoming events, leaders, albums and photos on the website.',
  },
];

/** Removes markup so the model receives readable text rather than HTML. */
function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A short plain-text preview. When the visitor's keyword appears in a long
 * article, centre the snippet on it so the model gets the relevant passage
 * instead of only the opening paragraph.
 */
function snippet(value: unknown, query: string, max: number): string {
  const text = plainText(value);
  if (!text || max <= 0) return '';
  if (text.length <= max) return text;

  if (query) {
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index >= 0) {
      const start = Math.max(0, index - Math.floor(max / 4));
      const end = Math.min(text.length, start + max);
      return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
    }
  }

  return `${text.slice(0, max)}...`;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** Reads and bounds the optional model-supplied search term. */
function readQuery(args: Record<string, unknown>): string {
  if (typeof args.query !== 'string') return '';
  return args.query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

function likePattern(query: string): string {
  return `%${query.replace(/[!%_]/g, '!$&')}%`;
}

// Filler the model sometimes passes along with the real topic ("programmes
// about prayer"). Dropping it keeps a multi-word query from requiring a phrase
// that no row contains.
const SEARCH_STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'been', 'blog', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'event',
  'events', 'for', 'from', 'had', 'has', 'have', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'news', 'of', 'on', 'or', 'our', 'please',
  'program', 'programme', 'programmes', 'programs', 'show', 'some', 'song',
  'songs', 'tell', 'that', 'the', 'their', 'them', 'this', 'to', 'track',
  'tracks', 'us', 'want', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

const MAX_SEARCH_TOKENS = 6;

/** Meaningful keywords from the model's query, deduplicated and bounded. */
function searchTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || SEARCH_STOPWORDS.has(word) || tokens.includes(word)) continue;
    tokens.push(word);
    if (tokens.length === MAX_SEARCH_TOKENS) break;
  }
  return tokens;
}

/**
 * Builds `((col LIKE ?) OR (col LIKE ?)) AND/OR ...` for the given keywords.
 * Columns are fixed by the caller, so only the pattern values are bound.
 */
function tokenWhere(
  tokens: string[],
  columns: string[],
  mode: 'AND' | 'OR'
): { sql: string; params: string[] } {
  const clauses = tokens.map(
    () => `(${columns.map((column) => `${column} LIKE ? ${LIKE_ESCAPE}`).join(' OR ')})`
  );
  return {
    sql: clauses.join(` ${mode} `),
    params: tokens.flatMap((token) => columns.map(() => likePattern(token))),
  };
}

/**
 * Runs `strict` (all keywords) first, then `loose` (any keyword) so a visitor
 * who adds one extra word still finds relevant rows.
 */
async function keywordRows(
  tokens: string[],
  columns: string[],
  run: (where: { sql: string; params: string[] }) => Promise<Record<string, unknown>[]>
): Promise<Record<string, unknown>[]> {
  const attempts = [tokenWhere(tokens, columns, 'AND')];
  if (tokens.length > 1) attempts.push(tokenWhere(tokens, columns, 'OR'));
  for (const attempt of attempts) {
    const rows = await run(attempt);
    if (rows.length > 0) return rows;
  }
  return [];
}

function mapProgram(row: Record<string, unknown>, query: string) {
  return {
    id: text(row.id),
    title: text(row.title) ?? '',
    description: snippet(row.description, query, 600),
    track_count: number(row.track_count),
    created_at: isoDate(row.created_at),
  };
}

function mapTrack(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    title: text(row.title) ?? '',
    artist: text(row.artist),
    album: text(row.album),
    duration_seconds: number(row.duration),
    track_type: text(row.track_type),
    program_id: text(row.program_id),
    program_title: text(row.program_title),
    created_at: isoDate(row.created_at),
  };
}

function mapArticle(row: Record<string, unknown>, query: string) {
  return {
    id: text(row.id),
    slug: text(row.slug),
    title: text(row.title) ?? '',
    excerpt: snippet(row.excerpt, query, 500),
    category: text(row.category),
    content_preview: snippet(row.body, query, 1000),
    created_at: isoDate(row.created_at),
  };
}

function mapAnnouncement(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    title: text(row.title) ?? '',
    body: snippet(row.body, '', 700),
    pinned: flag(row.pinned),
    created_at: isoDate(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>, query: string) {
  return {
    id: text(row.id),
    title: text(row.title) ?? '',
    description: snippet(row.description, query, 600),
    location: text(row.location),
    starts_at: isoDate(row.starts_at),
    ends_at: isoDate(row.ends_at),
  };
}

function mapLeader(row: Record<string, unknown>) {
  return {
    name: text(row.name) ?? '',
    title: text(row.title) ?? '',
    role_label: text(row.role_label),
    quote: snippet(row.quote, '', 300),
  };
}

function mapAlbum(row: Record<string, unknown>, query: string) {
  return {
    id: text(row.id),
    title: text(row.title) ?? '',
    description: snippet(row.description, query, 500),
    photo_count: number(row.photo_count),
    created_at: isoDate(row.created_at),
  };
}

async function searchPrograms(query: string): Promise<unknown> {
  const tokens = searchTokens(query);
  const columns = ['p.title', 'p.description'];
  const select = `
    SELECT p.id, p.title, p.description, p.created_at,
      (SELECT COUNT(*) FROM tracks t WHERE t.program_id = p.id) AS track_count
    FROM programs p`;
  const newest = () => queryAll<Record<string, unknown>>(
    `${select} ORDER BY p.created_at DESC LIMIT ${MAX_PROGRAMS}`
  );

  let rows: Record<string, unknown>[];
  if (tokens.length === 0) {
    rows = await newest();
  } else {
    rows = await keywordRows(tokens, columns, (where) =>
      queryAll<Record<string, unknown>>(
        `${select} WHERE ${where.sql} ORDER BY p.created_at DESC LIMIT ${MAX_PROGRAMS}`,
        where.params
      )
    );
  }

  let note: string | undefined;
  if (tokens.length > 0 && rows.length === 0) {
    rows = await newest();
    note = 'No keyword match. Showing the newest programmes instead.';
  }

  return {
    programs: rows.map((row) => mapProgram(row, tokens[0] ?? query)),
    ...(note ? { matched: false, note } : {}),
  };
}

async function searchTracks(query: string): Promise<unknown> {
  const tokens = searchTokens(query);
  const columns = ['t.title', 't.artist', 't.album', 'p.title', 'p.description'];
  const select = `
    SELECT t.id, t.title, t.artist, t.album, t.duration, t.track_type,
      t.program_id, p.title AS program_title, t.created_at
    FROM tracks t
    JOIN programs p ON p.id = t.program_id`;
  const newest = () => queryAll<Record<string, unknown>>(
    `${select} ORDER BY t.created_at DESC LIMIT ${MAX_TRACKS}`
  );

  let rows: Record<string, unknown>[];
  if (tokens.length === 0) {
    rows = await newest();
  } else {
    rows = await keywordRows(tokens, columns, (where) =>
      queryAll<Record<string, unknown>>(
        `${select} WHERE ${where.sql} ORDER BY t.created_at DESC LIMIT ${MAX_TRACKS}`,
        where.params
      )
    );
  }

  let note: string | undefined;
  if (tokens.length > 0 && rows.length === 0) {
    rows = await newest();
    note = 'No keyword match. Showing the newest tracks instead.';
  }

  return {
    tracks: rows.map(mapTrack),
    ...(note ? { matched: false, note } : {}),
  };
}

async function searchArticles(query: string): Promise<unknown> {
  const tokens = searchTokens(query);
  const columns = ['title', 'excerpt', 'category', 'body'];
  const select = `
    SELECT id, slug, title, excerpt, category, LEFT(body, 8000) AS body, created_at
    FROM blog_posts`;
  const newest = () => queryAll<Record<string, unknown>>(
    `${select} WHERE published = 1 ORDER BY created_at DESC LIMIT ${MAX_ARTICLES}`
  );

  let rows: Record<string, unknown>[];
  if (tokens.length === 0) {
    rows = await newest();
  } else {
    rows = await keywordRows(tokens, columns, (where) =>
      queryAll<Record<string, unknown>>(
        `${select} WHERE published = 1 AND (${where.sql}) ORDER BY created_at DESC LIMIT ${MAX_ARTICLES}`,
        where.params
      )
    );
  }

  let note: string | undefined;
  if (tokens.length > 0 && rows.length === 0) {
    rows = await newest();
    note = 'No keyword match. Showing the newest published articles instead.';
  }

  return {
    articles: rows.map((row) => mapArticle(row, tokens[0] ?? query)),
    ...(note ? { matched: false, note } : {}),
  };
}

async function listAnnouncements(): Promise<unknown> {
  const rows = await queryAll(`
    SELECT id, title, LEFT(body, 4000) AS body, pinned, created_at
    FROM announcements
    ORDER BY pinned DESC, created_at DESC
    LIMIT ${MAX_ANNOUNCEMENTS}
  `);

  return { announcements: rows.map(mapAnnouncement) };
}

async function listEvents(scope: string): Promise<unknown> {
  // The scope only chooses between three fixed SQL fragments, so the model
  // cannot inject an ORDER BY or a WHERE clause of its own.
  let whereAndOrder: string;
  if (scope === 'past') {
    whereAndOrder = 'WHERE starts_at < NOW() ORDER BY starts_at DESC';
  } else if (scope === 'all') {
    whereAndOrder = 'ORDER BY starts_at DESC';
  } else {
    whereAndOrder = 'WHERE starts_at >= NOW() ORDER BY starts_at ASC';
  }

  const rows = await queryAll(`
    SELECT id, title, LEFT(description, 2000) AS description,
      location, starts_at, ends_at
    FROM events
    ${whereAndOrder}
    LIMIT ${MAX_EVENTS}
  `);

  return {
    scope: scope === 'past' || scope === 'all' ? scope : 'upcoming',
    events: rows.map((row) => mapEvent(row, '')),
  };
}

async function listLeaders(): Promise<unknown> {
  const rows = await queryAll(`
    SELECT name, title, role_label, quote
    FROM leaders
    ORDER BY sort_order ASC, created_at ASC
    LIMIT ${MAX_LEADERS}
  `);

  return { leaders: rows.map(mapLeader) };
}

async function listAlbums(): Promise<unknown> {
  const rows = await queryAll(`
    SELECT a.id, a.title, a.description, a.created_at,
      (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photo_count
    FROM albums a
    ORDER BY a.created_at DESC
    LIMIT ${MAX_ALBUMS}
  `);

  return { albums: rows.map((row) => mapAlbum(row, '')) };
}

async function getContentStats(): Promise<unknown> {
  const row = await queryOne<Record<string, unknown>>(`
    SELECT
      (SELECT COUNT(*) FROM programs) AS programs,
      (SELECT COUNT(*) FROM tracks) AS tracks,
      (SELECT COUNT(*) FROM blog_posts WHERE published = 1) AS published_articles,
      (SELECT COUNT(*) FROM announcements) AS announcements,
      (SELECT COUNT(*) FROM events WHERE starts_at >= NOW()) AS upcoming_events,
      (SELECT COUNT(*) FROM leaders) AS leaders,
      (SELECT COUNT(*) FROM albums) AS albums,
      (SELECT COUNT(*) FROM album_photos) AS photos
  `);

  return {
    counts: {
      programs: number(row?.programs),
      tracks: number(row?.tracks),
      published_articles: number(row?.published_articles),
      announcements: number(row?.announcements),
      upcoming_events: number(row?.upcoming_events),
      leaders: number(row?.leaders),
      albums: number(row?.albums),
      photos: number(row?.photos),
    },
  };
}

/**
 * Runs one model-requested tool. Unknown names and failures return an `error`
 * the model can explain to the visitor instead of failing the whole chat.
 */
export async function executeChatTool(call: ChatFunctionCall): Promise<ChatToolResult> {
  const name = typeof call?.name === 'string' ? call.name : '';
  const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args)
    ? call.args
    : {};
  const query = readQuery(args);

  try {
    switch (name) {
      case 'search_programs':
        return { output: await searchPrograms(query) };
      case 'search_tracks':
        return { output: await searchTracks(query) };
      case 'search_blog_posts':
        return { output: await searchArticles(query) };
      case 'list_announcements':
        return { output: await listAnnouncements() };
      case 'list_events': {
        const scope = args.scope === 'past' || args.scope === 'all' ? args.scope : 'upcoming';
        return { output: await listEvents(scope) };
      }
      case 'list_leaders':
        return { output: await listLeaders() };
      case 'list_albums':
        return { output: await listAlbums() };
      case 'get_content_stats':
        return { output: await getContentStats() };
      default:
        return { error: 'That information is not available to the website assistant.' };
    }
  } catch (error) {
    // Never pass a driver error back to the model: it can contain table or
    // column names and makes the visitor's answer read like a stack trace.
    console.error(`[chat] database tool ${name || '(unnamed)'} failed:`,
      error instanceof Error ? error.message : String(error));
    return { error: 'The website content could not be loaded right now.' };
  }
}
