import { createHash } from 'crypto';
import { cacheDelete } from '../cache/redis';
import { queryAll, runSQL } from '../database/schema';
import {
  extractKeywords,
  invalidateChatbotCache,
  isLang,
  KNOWLEDGE_CACHE_KEY,
  Lang,
  loadSettings,
} from './chatbot';

export const SYNCED_TABLES = [
  'announcements',
  'events',
  'blog_posts',
  'programs',
  'tracks',
  'albums',
  'leaders',
  'radio_schedule',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export const LATEST_TRACKS_SUMMARY_ID = 'chat-summary-tracks-latest-en';
const LATEST_TRACKS_SUMMARY_SQL = 'SELECT id, title, artist, program_id, created_at FROM tracks ORDER BY created_at DESC LIMIT 5';

export const EVENTS_SUMMARY_ID = 'chat-summary-events-upcoming-en';
const EVENTS_SUMMARY_SQL = `SELECT id, title, description, location, starts_at, created_at
  FROM events
  ORDER BY starts_at >= NOW() DESC, starts_at DESC, created_at DESC
  LIMIT 5`;

export const WHATS_NEW_SUMMARY_ID = 'chat-summary-whats-new-en';
const WHATS_NEW_SQLS = {
  blog_posts: 'SELECT id, slug, title, excerpt, body, created_at FROM blog_posts WHERE published = 1 ORDER BY created_at DESC LIMIT 5',
  announcements: 'SELECT id, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT 5',
  events: 'SELECT id, title, description, location, starts_at, created_at FROM events ORDER BY created_at DESC LIMIT 5',
} as const;

interface ContentRow {
  id: string;
  title: string;
  artist?: string | null;
  body?: string | null;
  description?: string | null;
  excerpt?: string | null;
  slug?: string | null;
  quote?: string | null;
  host?: string | null;
  location?: string | null;
  day?: string | null;
  hour?: number | null;
  starts_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  program_id?: string | null;
  name?: string | null;
}

const SOURCE_SQL: Record<SyncedTable, string> = {
  announcements: 'SELECT id, title, body, created_at FROM announcements WHERE 1 = 1',
  events: 'SELECT id, title, description, location, starts_at, created_at FROM events WHERE 1 = 1',
  blog_posts: 'SELECT id, slug, title, excerpt, body, created_at, updated_at FROM blog_posts WHERE published = 1',
  programs: 'SELECT id, title, description, created_at FROM programs WHERE 1 = 1',
  tracks: 'SELECT id, title, artist, album, program_id, created_at FROM tracks WHERE 1 = 1',
  albums: 'SELECT id, title, description, created_at FROM albums WHERE 1 = 1',
  leaders: 'SELECT id, name, title, quote, created_at FROM leaders WHERE 1 = 1',
  radio_schedule: 'SELECT id, day, hour, title, host, category, created_at FROM radio_schedule WHERE 1 = 1',
};

const OM_MARKERS = [
  'wangeela', 'sagalee', 'barruu', 'beeksisaa', 'sagantaa', 'tajaajila',
  'michummaa', 'kadhanna', 'dhugaa', 'gaaffii', 'deebii', 'haaraa',
];

export function detectLanguage(text: string): Lang {
  if (/[\u1200-\u137F]/.test(text)) return 'am';
  const lower = text.toLowerCase();
  if (OM_MARKERS.some((word) => lower.includes(word))) return 'om';
  return 'en';
}

function titleOf(table: SyncedTable, row: ContentRow): string {
  if (table === 'leaders') return [row.name, row.title].filter(Boolean).join(' — ');
  if (table === 'radio_schedule') return [row.day, row.hour !== null && row.hour !== undefined ? `${String(row.hour).padStart(2, '0')}:00` : '', row.title].filter(Boolean).join(' · ');
  return row.title || 'Untitled';
}

function bodyOf(table: SyncedTable, row: ContentRow): string {
  const parts = [row.body, row.description, row.excerpt, row.quote, row.host].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  if (table === 'events' && row.starts_at) parts.unshift(`Date: ${row.starts_at}`);
  return parts.join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function urlOf(table: SyncedTable, row: ContentRow): string {
  switch (table) {
    case 'blog_posts': return row.slug ? `/blog/${row.slug}` : '/blog';
    case 'programs': return `/programs/${row.id}`;
    case 'tracks': return row.program_id ? `/programs/${row.program_id}` : '/programs';
    case 'albums': return '/gallery';
    case 'leaders': return '/leadership';
    case 'events': return '/#events';
    case 'announcements': return '/#announcements';
    case 'radio_schedule': return '/programs';
  }
}

function versionOf(table: SyncedTable, row: ContentRow): string {
  const source = `${row.updated_at ?? ''}|${row.created_at ?? ''}|${titleOf(table, row)}|${bodyOf(table, row)}`;
  return createHash('sha1').update(source).digest('hex').slice(0, 20);
}

function syncId(kind: 'knowledge' | 'source', table: SyncedTable, sourceId: string, lang: Lang): string {
  const hash = createHash('sha1').update(`${kind}:${table}:${sourceId}:${lang}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function syncLatestTracksSummary(status: 'approved' | 'pending'): Promise<number> {
  const rows = await queryAll<ContentRow>(LATEST_TRACKS_SUMMARY_SQL, []);
  if (rows.length === 0) {
    await runSQL('DELETE FROM chatbot_knowledge WHERE id = ?', [LATEST_TRACKS_SUMMARY_ID]);
    await invalidateChatbotCache();
    return 0;
  }

  const version = createHash('sha1')
    .update(rows.map((row) => `${row.id}|${row.updated_at ?? row.created_at ?? ''}|${row.title}|${row.artist ?? ''}`).join('|'))
    .digest('hex')
    .slice(0, 20);
  const list = rows
    .map((row, index) => `${index + 1}. ${titleOf('tracks', row)}${row.artist ? ` — ${row.artist}` : ''}`)
    .join('\n');
  const answer = `Latest tracks from our media library:\n${list}\nOpen /programs/latest to browse them.`;

  await runSQL(
    `INSERT INTO chatbot_knowledge
      (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
       source_type, source_table, source_id, source_url, content_version, sync_status, approved_at)
     VALUES (?, (SELECT id FROM chatbot_intents WHERE name = 'media' LIMIT 1), ?, ?, ?, ?, ?, ?, 1,
             'content_sync', 'tracks', 'latest', '/programs/latest', ?, ?, ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       question = VALUES(question), alternative_questions = VALUES(alternative_questions),
       keywords = VALUES(keywords), answer = VALUES(answer), source_url = VALUES(source_url),
       content_version = VALUES(content_version), sync_status = VALUES(sync_status),
       is_active = 1, updated_at = CURRENT_TIMESTAMP`,
    [LATEST_TRACKS_SUMMARY_ID, 'en', 'Which are the latest tracks?', JSON.stringify([
      'which is latest tracks',
      'latest tracks',
      'newest tracks',
      'recent songs',
      'recent recordings',
      'latest audio',
    ]), JSON.stringify(['latest', 'track', 'new', 'newest', 'recent', 'recording', 'song', 'audio', 'media']),
      answer, 92, version, status]
  );

  await runSQL(
    `INSERT INTO chatbot_content_sources
      (id, source_table, source_id, language, content_version, status, last_synced_at)
     VALUES (?, 'tracks', 'latest', 'en', ?, 'synced', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE content_version = VALUES(content_version), status = VALUES(status),
       last_error = NULL, last_synced_at = CURRENT_TIMESTAMP`,
    [syncId('source', 'tracks', 'latest', 'en'), version]
  );

  return 1;
}

function eventDate(value?: string | null): string {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

async function syncUpcomingEventsSummary(status: 'approved' | 'pending'): Promise<number> {
  const rows = await queryAll<ContentRow>(EVENTS_SUMMARY_SQL, []);
  const version = createHash('sha1')
    .update(rows.map((row) => `${row.id}|${row.updated_at ?? row.created_at ?? ''}|${row.title}|${row.starts_at ?? ''}|${row.location ?? ''}`).join('|'))
    .digest('hex')
    .slice(0, 20);
  const answer = rows.length
    ? `Events from our database:\n${rows.map((row, index) => {
        const date = eventDate(row.starts_at);
        const location = row.location ? ` — ${row.location}` : '';
        const detail = row.description ? ` — ${row.description.replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
        return `${index + 1}. ${row.title}${date ? ` — ${date}` : ''}${location}${detail}`;
      }).join('\n')}\nSee the Events section on the homepage for full details.`
    : 'There are no events posted yet. Check the Events section on the homepage for updates.';

  await runSQL(
    `INSERT INTO chatbot_knowledge
      (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
       source_type, source_table, source_id, source_url, content_version, sync_status, approved_at)
     VALUES (?, (SELECT id FROM chatbot_intents WHERE name = 'events' LIMIT 1), ?, ?, ?, ?, ?, ?, 1,
             'content_sync', 'events', 'upcoming', '/#events', ?, ?, ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       question = VALUES(question), alternative_questions = VALUES(alternative_questions),
       keywords = VALUES(keywords), answer = VALUES(answer), source_url = VALUES(source_url),
       content_version = VALUES(content_version), sync_status = VALUES(sync_status),
       is_active = 1, updated_at = CURRENT_TIMESTAMP`,
    [EVENTS_SUMMARY_ID, 'en', 'What events are coming up?', JSON.stringify([
      'tell me events',
      'upcoming events',
      'when is the next event',
      'events this week',
      'event schedule',
      'list of events',
    ]), JSON.stringify(['event', 'upcoming', 'date', 'schedule', 'conference', 'meeting', 'location', 'starts']),
      answer, 94, version, status]
  );

  await runSQL(
    `INSERT INTO chatbot_content_sources
      (id, source_table, source_id, language, content_version, status, last_synced_at)
     VALUES (?, 'events', 'upcoming', 'en', ?, 'synced', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE content_version = VALUES(content_version), status = VALUES(status),
       last_error = NULL, last_synced_at = CURRENT_TIMESTAMP`,
    [syncId('source', 'events', 'upcoming', 'en'), version]
  );

  return 1;
}

async function syncWhatsNewSummary(status: 'approved' | 'pending'): Promise<number> {
  const [posts, announcements, events] = await Promise.all([
    queryAll<ContentRow>(WHATS_NEW_SQLS.blog_posts, []),
    queryAll<ContentRow>(WHATS_NEW_SQLS.announcements, []),
    queryAll<ContentRow>(WHATS_NEW_SQLS.events, []),
  ]);
  const items = [
    ...posts.map((row) => ({
      id: row.id, type: 'Blog', title: row.title,
      detail: row.excerpt || row.body, published: row.created_at ?? null,
    })),
    ...announcements.map((row) => ({
      id: row.id, type: 'Announcement', title: row.title,
      detail: row.body, published: row.created_at ?? null,
    })),
    ...events.map((row) => ({
      id: row.id, type: 'Event', title: row.title,
      detail: [eventDate(row.starts_at), row.location, row.description].filter(Boolean).join(' — '),
      published: row.created_at ?? null,
    })),
  ].sort((a, b) => String(b.published ?? '').localeCompare(String(a.published ?? ''))).slice(0, 5);

  const version = createHash('sha1')
    .update(items.map((item) => `${item.id}|${item.type}|${item.title}|${item.published ?? ''}|${item.detail ?? ''}`).join('|'))
    .digest('hex')
    .slice(0, 20);
  const answer = items.length
    ? `What's new on the website:\n${items.map((item, index) => {
        const detail = item.detail
          ? ` — ${item.detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`
          : '';
        return `${index + 1}. [${item.type}] ${item.title}${detail}`;
      }).join('\n')}\nCheck the home page or the Events section for full details.`
    : "There's nothing new posted yet. Check the home page for updates.";

  await runSQL(
    `INSERT INTO chatbot_knowledge
      (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
       source_type, source_table, source_id, source_url, content_version, sync_status, approved_at)
     VALUES (?, (SELECT id FROM chatbot_intents WHERE name = 'news' LIMIT 1), ?, ?, ?, ?, ?, ?, 1,
             'content_sync', 'events', 'whats-new', '/', ?, ?, ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       question = VALUES(question), alternative_questions = VALUES(alternative_questions),
       keywords = VALUES(keywords), answer = VALUES(answer), source_url = VALUES(source_url),
       content_version = VALUES(content_version), sync_status = VALUES(sync_status),
       is_active = 1, updated_at = CURRENT_TIMESTAMP`,
    [WHATS_NEW_SUMMARY_ID, 'en', "What's new on the website?", JSON.stringify([
      "what's new",
      "what's new?",
      'whats new',
      'what is new',
      'latest news',
      'new updates',
      'recent announcements',
      'new events',
    ]), JSON.stringify(['new', 'latest', 'news', 'event', 'announcement', 'blog', 'update', 'recent', 'post']),
      answer, 96, version, status]
  );

  await runSQL(
    `INSERT INTO chatbot_content_sources
      (id, source_table, source_id, language, content_version, status, last_synced_at)
     VALUES (?, 'events', 'whats-new', 'en', ?, 'synced', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE content_version = VALUES(content_version), status = VALUES(status),
       last_error = NULL, last_synced_at = CURRENT_TIMESTAMP`,
    [syncId('source', 'events', 'whats-new', 'en'), version]
  );

  return 1;
}

function prefixOf(table: SyncedTable): string {
  switch (table) {
    case 'announcements': return 'Announcement';
    case 'blog_posts': return 'Blog';
    case 'events': return 'Event';
    case 'programs': return 'Programme';
    case 'tracks': return 'Track';
    case 'albums': return 'Album';
    case 'leaders': return 'Leader';
    case 'radio_schedule': return 'Schedule';
  }
}

export async function syncContentSource(table: SyncedTable, sourceId?: string): Promise<number> {
  const sql = sourceId ? `${SOURCE_SQL[table]} AND id = ?` : SOURCE_SQL[table];
  const rows = await queryAll<ContentRow>(sql, sourceId ? [sourceId] : []);
  const settings = await loadSettings();
  const status = settings.autoApproveContent ? 'approved' : 'pending';
  let count = 0;

  for (const row of rows) {
    const title = titleOf(table, row);
    const body = bodyOf(table, row);
    const lang = detectLanguage(`${title} ${body}`);
    const version = versionOf(table, row);
    const knowledgeId = syncId('knowledge', table, row.id, lang);
    const keywords = extractKeywords(`${title} ${body.slice(0, 400)}`, lang);
    const answer = `${prefixOf(table)}: ${title}${body ? `. ${body}` : ''}${row.slug ? ` Read more: ${urlOf(table, row)}` : ''}`;
    const alternatives = [title, `${prefixOf(table).toLowerCase()} ${title}`];

    await runSQL(
      `INSERT INTO chatbot_knowledge
        (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
         source_type, source_table, source_id, source_url, content_version, sync_status, approved_at)
       VALUES (?, (SELECT id FROM chatbot_intents WHERE name = 'news' LIMIT 1), ?, ?, ?, ?, ?, ?, 1,
               'content_sync', ?, ?, ?, ?, ?, ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'})
       ON DUPLICATE KEY UPDATE
         question = VALUES(question), alternative_questions = VALUES(alternative_questions),
         keywords = VALUES(keywords), answer = VALUES(answer), source_url = VALUES(source_url),
         content_version = VALUES(content_version), sync_status = VALUES(sync_status),
         is_active = 1, updated_at = CURRENT_TIMESTAMP`,
       [knowledgeId, lang, `What do you know about ${title}?`, JSON.stringify(alternatives), JSON.stringify(keywords),
         answer, table === 'blog_posts' ? 65 : 55, table, row.id, urlOf(table, row), version, status]
    );

    await runSQL(
      `INSERT INTO chatbot_content_sources
        (id, source_table, source_id, language, content_version, status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 'synced', CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE content_version = VALUES(content_version), status = VALUES(status),
         last_error = NULL, last_synced_at = CURRENT_TIMESTAMP`,
      [syncId('source', table, row.id, lang), table, row.id, lang, version]
    );
    count += 1;
  }

  if (table === 'tracks') count += await syncLatestTracksSummary(status);
  if (table === 'events') count += await syncUpcomingEventsSummary(status);
  if (table === 'events' || table === 'announcements' || table === 'blog_posts') {
    count += await syncWhatsNewSummary(status);
  }

  if (sourceId) {
    const removed = await queryAll<{ id: string; language: string }>(
      'SELECT id, language FROM chatbot_knowledge WHERE source_table = ? AND source_id = ? AND content_version IS NOT NULL',
      [table, sourceId]
    );
    const currentIds = new Set(
      rows.map((current) => syncId(
        'knowledge',
        table,
        current.id,
        detectLanguage(`${titleOf(table, current)} ${bodyOf(table, current)}`)
      ))
    );
    for (const row of removed) {
      if (
        currentIds.has(row.id) ||
        row.id === LATEST_TRACKS_SUMMARY_ID ||
        row.id === EVENTS_SUMMARY_ID ||
        row.id === WHATS_NEW_SUMMARY_ID
      ) continue;
      await runSQL('DELETE FROM chatbot_knowledge WHERE id = ?', [row.id]);
      await runSQL(
        'DELETE FROM chatbot_content_sources WHERE source_table = ? AND source_id = ? AND language = ?',
        [table, sourceId, isLang(row.language) ? row.language : 'en']
      );
    }
  }

  if (count > 0) await invalidateChatbotCache();
  return count;
}

export async function syncAllContent(): Promise<number> {
  let total = 0;
  for (const table of SYNCED_TABLES) {
    try {
      total += await syncContentSource(table);
    } catch (error) {
      console.error(`[chatbot] content sync failed for ${table}:`, error);
    }
  }
  return total;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleContentSync(table: SyncedTable, sourceId?: string): void {
  const key = `${table}:${sourceId ?? '*'}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(key);
    void syncContentSource(table, sourceId).catch((error) => {
      console.error(`[chatbot] scheduled sync failed for ${key}:`, error);
    });
  }, 300);
  timer.unref?.();
  pending.set(key, timer);
}

export async function flushPendingSync(): Promise<void> {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  await syncAllContent();
}

export interface SyncStatusRow {
  source_table: string;
  source_id: string;
  language: string;
  content_version: string;
  status: string;
  last_error: string | null;
  last_synced_at: string;
}

export async function getSyncStatus(): Promise<SyncStatusRow[]> {
  return queryAll<SyncStatusRow>(
    'SELECT source_table, source_id, language, content_version, status, last_error, last_synced_at FROM chatbot_content_sources ORDER BY last_synced_at DESC LIMIT 200'
  );
}

export async function markSourceFailed(table: SyncedTable, sourceId: string, error: string): Promise<void> {
  await runSQL(
    `UPDATE chatbot_content_sources SET status = 'failed', last_error = ?
      WHERE source_table = ? AND source_id = ?`,
    [error.slice(0, 500), table, sourceId]
  );
  await cacheDelete(KNOWLEDGE_CACHE_KEY);
}

export function mapWritePathToSource(method: string, path: string): { table: SyncedTable; id?: string } | null {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return null;
  const clean = path.split('?')[0];
  const match = (prefix: string, table: SyncedTable) => {
    if (!clean.startsWith(prefix)) return null;
    const remainder = clean.slice(prefix.length).replace(/^\/+|\/+$/g, '');
    const id = remainder && !remainder.includes('/') ? remainder : undefined;
    return { table, id };
  };
  if (clean === '/api/site/announcements' || clean.startsWith('/api/site/announcements/')) return match('/api/site/announcements', 'announcements');
  if (clean === '/api/site/events' || clean.startsWith('/api/site/events/')) return match('/api/site/events', 'events');
  if (clean === '/api/site/blog' || clean.startsWith('/api/site/blog/')) return match('/api/site/blog', 'blog_posts');
  if (clean === '/api/site/albums' || clean.startsWith('/api/site/albums/')) return match('/api/site/albums', 'albums');
  if (clean === '/api/site/leaders' || clean.startsWith('/api/site/leaders/')) return match('/api/site/leaders', 'leaders');
  if (clean === '/api/site/schedule' || clean.startsWith('/api/site/schedule/')) return match('/api/site/schedule', 'radio_schedule');
  if (clean === '/api/programs' || clean.startsWith('/api/programs/')) {
    if (clean.includes('/comments') || clean.includes('/reorder')) return null;
    return match('/api/programs', 'programs');
  }
  if ((clean === '/api/tracks' || clean.startsWith('/api/tracks/')) && !clean.includes('/groups') && !clean.includes('/upload')) {
    return match('/api/tracks', 'tracks');
  }
  return null;
}

export function startChatbotSyncScheduler(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void syncAllContent().catch((error) => console.error('[chatbot] scheduled sync failed:', error));
  }, 10 * 60 * 1000);
  timer.unref?.();
  return timer;
}

export function normalizeSyncedLanguage(value: unknown): Lang {
  return isLang(value) ? value : 'en';
}
