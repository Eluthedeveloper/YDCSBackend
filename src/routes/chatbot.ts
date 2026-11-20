import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler } from '../lib/asyncHandler';
import {
  findBestMatch,
  getSuggestions,
  isFollowUp,
  isLang,
  Lang,
  loadKnowledge,
  loadSettings,
  normaliseText,
} from '../lib/chatbot';
import { queryOne, runSQL } from '../database/schema';
import { chatLimiter } from '../middleware/rateLimit';

const router = Router();

const MAX_MESSAGE_CHARS = 1500;
const MAX_SESSION_CHARS = 191;

interface ConversationRow {
  id: string;
  session_id: string;
  language: Lang;
  context_intent_id: string | null;
  context_data: string | null;
}

const safeSession = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 8 && trimmed.length <= MAX_SESSION_CHARS && /^[A-Za-z0-9._:-]+$/.test(trimmed)
    ? trimmed
    : null;
};

const chooseLang = (value: unknown, enabled: Lang[]): Lang => {
  if (isLang(value) && enabled.includes(value)) return value;
  return enabled[0] ?? 'en';
};

const parseContext = (raw: string | null): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]))
      : {};
  } catch {
    return {};
  }
};

router.post('/message', chatLimiter, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: 'A message between 1 and 1500 characters is required' });
  }

  const sessionId = safeSession(body.sessionId) ?? uuidv4();
  const settings = await loadSettings();
  const lang = chooseLang(body.lang, settings.enabledLanguages);
  const restart = body.restart === true;

  let conversation = await queryOne<ConversationRow>(
    'SELECT id, session_id, language, context_intent_id, context_data FROM chatbot_conversations WHERE session_id = ? ORDER BY last_activity DESC LIMIT 1',
    [sessionId]
  );

  if (!conversation) {
    const id = uuidv4();
    await runSQL(
      'INSERT INTO chatbot_conversations (id, session_id, language) VALUES (?, ?, ?)',
      [id, sessionId, lang]
    );
    conversation = { id, session_id: sessionId, language: lang, context_intent_id: null, context_data: null };
  } else if (restart) {
    await runSQL(
      'UPDATE chatbot_conversations SET language = ?, context_intent_id = NULL, context_data = NULL, last_activity = CURRENT_TIMESTAMP WHERE id = ?',
      [lang, conversation.id]
    );
    conversation.context_intent_id = null;
    conversation.context_data = null;
    await runSQL(
      'INSERT INTO chatbot_messages (id, conversation_id, sender, message, confidence_score) VALUES (?, ?, ?, ?, NULL)',
      [uuidv4(), conversation.id, 'bot', settings.welcomeMessages[lang] ?? settings.welcomeMessages.en]
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      reply: settings.welcomeMessages[lang] ?? settings.welcomeMessages.en,
      matched: true,
      restarted: true,
      language: lang,
      conversationId: conversation.id,
    });
  } else if (conversation.language !== lang) {
    await runSQL('UPDATE chatbot_conversations SET language = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?', [lang, conversation.id]);
  }

  await runSQL(
    'INSERT INTO chatbot_messages (id, conversation_id, sender, message, confidence_score) VALUES (?, ?, ?, ?, NULL)',
    [uuidv4(), conversation.id, 'visitor', message]
  );

  const entries = await loadKnowledge();
  const context = parseContext(conversation.context_data);
  const followUp = isFollowUp(message, lang);
  let match = findBestMatch(
    message,
    lang,
    settings,
    entries,
    conversation.context_intent_id,
    followUp ? context.lastMatchedId : null
  );

  if (!match && followUp && conversation.context_intent_id) {
    match = findBestMatch(
      message,
      lang,
      settings,
      entries.filter((entry) => entry.intentId === conversation.context_intent_id)
    );
  }

  const reply = match?.entry.answer ?? settings.fallbackMessages[lang] ?? settings.fallbackMessages.en;
  const confidence = match ? Number(match.confidence.toFixed(4)) : 0;

  await runSQL(
    `INSERT INTO chatbot_messages
      (id, conversation_id, sender, message, matched_knowledge_id, confidence_score)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), conversation.id, 'bot', reply, match?.entry.id ?? null, confidence]
  );

  const nextContext = {
    ...context,
    ...(match ? { lastMatchedId: match.entry.id, lastQuestion: normaliseText(message).slice(0, 200) } : {}),
  };
  await runSQL(
    'UPDATE chatbot_conversations SET language = ?, context_intent_id = ?, context_data = ?, last_activity = CURRENT_TIMESTAMP WHERE id = ?',
    [lang, match?.entry.intentId ?? null, JSON.stringify(nextContext), conversation.id]
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    reply,
    matched: Boolean(match),
    intent: match?.entry.intentName ?? null,
    confidence,
    language: lang,
    conversationId: conversation.id,
  });
}));

router.get('/suggestions', asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  const lang = chooseLang(req.query.lang, settings.enabledLanguages);
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.json({ suggestions: await getSuggestions(lang) });
}));

router.get('/settings', asyncHandler(async (_req, res) => {
  const settings = await loadSettings();
  return res.json({
    welcomeMessages: settings.welcomeMessages,
    fallbackMessages: settings.fallbackMessages,
    enabledLanguages: settings.enabledLanguages,
    confidenceThreshold: settings.confidenceThreshold,
  });
}));

export default router;
