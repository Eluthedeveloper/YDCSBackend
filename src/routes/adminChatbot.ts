import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import { queryAll, queryOne, runSQL } from '../database/schema';
import {
  invalidateChatbotCache,
  isLang,
  Lang,
  loadSettings,
  SETTINGS_CACHE_KEY,
  type ChatbotSettings,
} from '../lib/chatbot';
import { getSyncStatus, syncAllContent, syncContentSource, SyncedTable, SYNCED_TABLES } from '../lib/chatbotSync';
import { cacheSet } from '../cache/redis';

const router = Router();
router.use(authenticate, requireAdmin);

/** The admin UI speaks snake_case; the shared chatbot library uses camelCase. */
function toWireSettings(settings: ChatbotSettings) {
  return {
    confidence_threshold: settings.confidenceThreshold,
    fuzzy_threshold: settings.fuzzyThreshold,
    welcome_messages: settings.welcomeMessages,
    fallback_messages: settings.fallbackMessages,
    enabled_languages: settings.enabledLanguages,
    auto_approve_content: settings.autoApproveContent,
    sync_interval_minutes: settings.syncIntervalMinutes,
    max_history_turns: settings.maxHistoryTurns,
  };
}

const MAX_LIST = 200;
const bool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const stringList = (value: unknown, max = 20): string[] | null => {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : null;
  if (!raw) return null;
  const list = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
  if (list.some((item) => item.length > 300)) return null;
  return list;
};
const intValue = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

interface KnowledgeRow {
  id: string;
  intent_id: string | null;
  intent_name: string | null;
  language: Lang;
  question: string;
  alternative_questions: string | null;
  keywords: string | null;
  answer: string;
  priority: number;
  is_active: number;
  source_type: 'manual' | 'content_sync';
  source_url: string | null;
  sync_status: 'approved' | 'pending' | 'rejected';
  updated_at: string;
}

router.get('/knowledge', asyncHandler(async (req, res) => {
  const limit = Math.min(MAX_LIST, Math.max(1, intValue(req.query.limit, MAX_LIST)));
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (isLang(req.query.lang)) {
    conditions.push('k.language = ?');
    params.push(req.query.lang);
  }
  if (typeof req.query.intent === 'string' && req.query.intent.trim()) {
    conditions.push('i.name = ?');
    params.push(req.query.intent.trim());
  }
  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    conditions.push('(k.question LIKE ? OR k.answer LIKE ?)');
    const like = `%${req.query.search.trim().replace(/[!%_]/g, '!$&')}%`;
    params.push(like, like);
  }
  const rows = await queryAll<KnowledgeRow>(
    `SELECT k.id, k.intent_id, i.name AS intent_name, k.language, k.question,
            k.alternative_questions, k.keywords, k.answer, k.priority, k.is_active,
            k.source_type, k.source_url, k.sync_status, k.updated_at
       FROM chatbot_knowledge k LEFT JOIN chatbot_intents i ON i.id = k.intent_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY k.priority DESC, k.updated_at DESC LIMIT ?`,
    [...params, limit]
  );
  return res.json(rows);
}));

router.post('/knowledge', asyncHandler(async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const question = text(body.question);
  const answer = text(body.answer);
  const language = isLang(body.language) ? body.language : null;
  const alternatives = stringList(body.alternative_questions);
  const keywords = stringList(body.keywords);
  if (!question || !answer || !language || question.length > 500 || !alternatives || !keywords) {
    return res.status(400).json({ error: 'question, answer, language and valid keyword lists are required' });
  }
  const intentId = text(body.intent_id);
  if (intentId && !await queryOne('SELECT id FROM chatbot_intents WHERE id = ?', [intentId])) {
    return res.status(400).json({ error: 'Unknown intent' });
  }
  const status = ['approved', 'pending', 'rejected'].includes(String(body.sync_status))
    ? String(body.sync_status) as 'approved' | 'pending' | 'rejected'
    : 'approved';
  const id = uuidv4();
  await runSQL(
    `INSERT INTO chatbot_knowledge
      (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
       sync_status, reviewed_by, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    [id, intentId, language, question, JSON.stringify(alternatives), JSON.stringify(keywords), answer,
      Math.max(-100, Math.min(100, intValue(body.priority, 0))), bool(body.is_active, true) ? 1 : 0,
      status, status === 'approved' ? req.user!.id : null]
  );
  await invalidateChatbotCache();
  return res.status(201).json({ id });
}));

router.put('/knowledge/:id', asyncHandler(async (req: AuthRequest, res) => {
  const id = req.params.id;
  const existing = await queryOne<KnowledgeRow>('SELECT * FROM chatbot_knowledge WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Knowledge entry not found' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const question = body.question === undefined ? existing.question : text(body.question);
  const answer = body.answer === undefined ? existing.answer : text(body.answer);
  const language = body.language === undefined ? existing.language : isLang(body.language) ? body.language : null;
  const alternatives = body.alternative_questions === undefined ? undefined : stringList(body.alternative_questions);
  const keywords = body.keywords === undefined ? undefined : stringList(body.keywords);
  if (!question || !answer || !language || question.length > 500 || (alternatives && alternatives.length > 20) || (keywords && keywords.length > 20)) {
    return res.status(400).json({ error: 'Invalid knowledge entry' });
  }
  const intentId = body.intent_id === undefined
    ? existing.intent_id
    : text(body.intent_id);
  if (intentId && !await queryOne('SELECT id FROM chatbot_intents WHERE id = ?', [intentId])) {
    return res.status(400).json({ error: 'Unknown intent' });
  }
  const status = ['approved', 'pending', 'rejected'].includes(String(body.sync_status))
    ? String(body.sync_status) as 'approved' | 'pending' | 'rejected'
    : existing.sync_status;
  await runSQL(
    `UPDATE chatbot_knowledge SET intent_id = ?, language = ?, question = ?, answer = ?,
       alternative_questions = ?, keywords = ?, priority = ?, is_active = ?, sync_status = ?,
       reviewed_by = ?, approved_at = ${status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL'}, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [intentId, language, question, answer,
      JSON.stringify(alternatives ?? JSON.parse(existing.alternative_questions || '[]')),
      JSON.stringify(keywords ?? JSON.parse(existing.keywords || '[]')),
      Math.max(-100, Math.min(100, intValue(body.priority, existing.priority))),
      bool(body.is_active, Boolean(existing.is_active)) ? 1 : 0,
      status, req.user!.id, id]
  );
  await invalidateChatbotCache();
  return res.json({ id });
}));

router.delete('/knowledge/:id', asyncHandler(async (req, res) => {
  const existing = await queryOne('SELECT id FROM chatbot_knowledge WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Knowledge entry not found' });
  await runSQL('DELETE FROM chatbot_knowledge WHERE id = ?', [req.params.id]);
  await invalidateChatbotCache();
  return res.json({ message: 'Knowledge entry deleted' });
}));

router.get('/intents', asyncHandler(async (_req, res) => {
  res.json(await queryAll('SELECT id, name, description, is_active FROM chatbot_intents ORDER BY name'));
}));

router.get('/analytics', asyncHandler(async (_req, res) => {
  const totals = await queryOne<{
    conversations: number; questions: number; answered: number; unanswered: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM chatbot_conversations) AS conversations,
       (SELECT COUNT(*) FROM chatbot_messages WHERE sender = 'visitor') AS questions,
       (SELECT COUNT(*) FROM chatbot_messages WHERE sender = 'bot' AND matched_knowledge_id IS NOT NULL) AS answered,
       (SELECT COUNT(*) FROM chatbot_messages WHERE sender = 'bot' AND matched_knowledge_id IS NULL) AS unanswered`
  );
  const topQuestions = await queryAll<{ question: string; count: number }>(
    `SELECT message AS question, COUNT(*) AS count FROM chatbot_messages
      WHERE sender = 'visitor' GROUP BY message ORDER BY count DESC, message ASC LIMIT 10`
  );
  const topIntents = await queryAll<{ intent: string; count: number }>(
    `SELECT k.question AS intent, COUNT(*) AS count FROM chatbot_messages m
       JOIN chatbot_knowledge k ON k.id = m.matched_knowledge_id
      WHERE m.sender = 'bot' GROUP BY k.id ORDER BY count DESC LIMIT 10`
  );
  const totalQuestions = Number(totals?.questions ?? 0);
  const answered = Number(totals?.answered ?? 0);
  return res.json({
    totals: {
      conversations: Number(totals?.conversations ?? 0),
      questions: totalQuestions,
      answered,
      unanswered: Number(totals?.unanswered ?? 0),
      successRate: totalQuestions ? Number(((answered / totalQuestions) * 100).toFixed(1)) : 0,
    },
    topQuestions,
    topIntents,
  });
}));

router.get('/unanswered', asyncHandler(async (req, res) => {
  const limit = Math.min(MAX_LIST, Math.max(1, intValue(req.query.limit, 100)));
  const rows = await queryAll(
    `SELECT m.id, m.message, m.confidence_score, m.created_at, c.language, c.session_id
       FROM chatbot_messages m JOIN chatbot_conversations c ON c.id = m.conversation_id
      WHERE m.sender = 'bot' AND m.matched_knowledge_id IS NULL
      ORDER BY m.created_at DESC LIMIT ?`,
    [limit]
  );
  res.json(rows);
}));

router.get('/conversations', asyncHandler(async (req, res) => {
  const limit = Math.min(MAX_LIST, Math.max(1, intValue(req.query.limit, 50)));
  const search = typeof req.query.search === 'string' && req.query.search.trim()
    ? `%${req.query.search.trim().replace(/[!%_]/g, '!$&')}%`
    : null;
  const rows = await queryAll(
    `SELECT c.id, c.session_id, c.language, c.started_at, c.last_activity,
       (SELECT COUNT(*) FROM chatbot_messages m WHERE m.conversation_id = c.id) AS message_count,
       (SELECT COUNT(*) FROM chatbot_messages m WHERE m.conversation_id = c.id AND m.sender = 'bot' AND m.matched_knowledge_id IS NULL) AS unanswered
       FROM chatbot_conversations c
       ${search ? 'WHERE EXISTS (SELECT 1 FROM chatbot_messages m WHERE m.conversation_id = c.id AND m.message LIKE ? ESCAPE \'!\')' : ''}
      ORDER BY c.last_activity DESC LIMIT ?`,
    search ? [search, limit] : [limit]
  );
  res.json(rows);
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const conversation = await queryOne('SELECT * FROM chatbot_conversations WHERE id = ?', [req.params.id]);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const messages = await queryAll(
    'SELECT id, sender, message, matched_knowledge_id, confidence_score, created_at FROM chatbot_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200',
    [req.params.id]
  );
  res.json({ conversation, messages });
}));

router.get('/settings', asyncHandler(async (_req, res) => {
  res.json(toWireSettings(await loadSettings()));
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = new Set([
    'confidence_threshold', 'fuzzy_threshold', 'welcome_messages', 'fallback_messages',
    'enabled_languages', 'auto_approve_content', 'sync_interval_minutes', 'max_history_turns',
  ]);
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue;
    let stored: string;
    if (['confidence_threshold', 'fuzzy_threshold'].includes(key)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0 || number > 1) {
        return res.status(400).json({ error: `${key} must be between 0 and 1` });
      }
      stored = String(number);
    } else if (['sync_interval_minutes', 'max_history_turns'].includes(key)) {
      const number = Number.parseInt(String(value), 10);
      if (!Number.isFinite(number) || number <= 0) return res.status(400).json({ error: `${key} must be positive` });
      stored = String(number);
    } else if (key === 'auto_approve_content') {
      stored = bool(value, true) ? 'true' : 'false';
    } else if (key === 'enabled_languages') {
      if (!Array.isArray(value) || !value.every(isLang) || value.length === 0) {
        return res.status(400).json({ error: 'enabled_languages must be a non-empty list of en, am, om' });
      }
      stored = JSON.stringify(value);
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return res.status(400).json({ error: `${key} must be a language map` });
      }
      const map = value as Record<string, unknown>;
      if (!['en', 'am', 'om'].every((lang) => typeof map[lang] === 'string' && (map[lang] as string).trim())) {
        return res.status(400).json({ error: `${key} needs en, am and om messages` });
      }
      stored = JSON.stringify(map);
    }
    await runSQL(
      `INSERT INTO chatbot_settings (id, setting_key, setting_value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`,
      [`chat-setting-${key}`, key, stored]
    );
  }
  await invalidateChatbotCache();
  await cacheSet(SETTINGS_CACHE_KEY, await loadSettings());
  res.json(toWireSettings(await loadSettings()));
}));

router.get('/sync/status', asyncHandler(async (_req, res) => {
  res.json({ sources: await getSyncStatus() });
}));

router.post('/sync/run', asyncHandler(async (req, res) => {
  const table = String((req.body as Record<string, unknown> | undefined)?.table ?? '');
  if (table && !(SYNCED_TABLES as readonly string[]).includes(table)) {
    return res.status(400).json({ error: 'Unknown content source' });
  }
  const count = table ? await syncContentSource(table as SyncedTable) : await syncAllContent();
  await invalidateChatbotCache();
  res.json({ synced: count });
}));

export default router;
