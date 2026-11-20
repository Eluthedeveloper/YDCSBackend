import Fuse from 'fuse.js';
import { cacheDelete, cacheGet, cacheSet } from '../cache/redis';
import { queryAll, queryOne } from '../database/schema';

export const LANGS = ['en', 'am', 'om'] as const;
export type Lang = (typeof LANGS)[number];

export const KNOWLEDGE_CACHE_KEY = 'chatbot:knowledge';
export const SETTINGS_CACHE_KEY = 'chatbot:settings';
export const SUGGESTIONS_CACHE_KEY = (lang: Lang) => `chatbot:suggestions:${lang}`;

export interface ChatbotSettings {
  confidenceThreshold: number;
  fuzzyThreshold: number;
  welcomeMessages: Record<Lang, string>;
  fallbackMessages: Record<Lang, string>;
  enabledLanguages: Lang[];
  autoApproveContent: boolean;
  syncIntervalMinutes: number;
  maxHistoryTurns: number;
}

export interface KnowledgeEntry {
  id: string;
  intentId: string | null;
  intentName: string;
  language: Lang;
  question: string;
  alternatives: string[];
  keywords: string[];
  answer: string;
  priority: number;
  sourceType: 'manual' | 'content_sync';
  sourceUrl: string | null;
}

export interface MatchResult {
  entry: KnowledgeEntry;
  confidence: number;
}

interface KnowledgeRow {
  id: string;
  intent_id: string | null;
  intent_name: string | null;
  language: string;
  question: string;
  alternative_questions: string | null;
  keywords: string | null;
  answer: string;
  priority: number;
  source_type: 'manual' | 'content_sync';
  source_url: string | null;
}

const DEFAULT_SETTINGS: ChatbotSettings = {
  confidenceThreshold: 0.38,
  fuzzyThreshold: 0.42,
  welcomeMessages: {
    en: 'Welcome! Ask me about our ministry, programmes or contact details.',
    am: 'እንኳን ደህና መጡ! ስለ አገልግሎታችን፣ ፕሮግራሞች ወይም ማነጋገሪያዎች ይጠይቁ።',
    om: 'Baga nagaan dhuftan! Tajaajila, sagantaa ykn hariiroo nuun gaafadhaa.',
  },
  fallbackMessages: {
    en: "I couldn't find a reliable answer for that. Try another question or contact us directly.",
    am: 'ለዚህ ጥያቄ አስተማማኝ መልስ አላገኘሁም። ሌላ ጥያቄ ይሞክሩ ወይም በቀጥታ ያነጋግሩን።',
    om: 'Deebii amanamaa hin argattelle. Gaaffii biraa yaali ykn kallattiin nu qaba.',
  },
  enabledLanguages: [...LANGS],
  autoApproveContent: true,
  syncIntervalMinutes: 10,
  maxHistoryTurns: 8,
};

const STOPWORDS: Record<Lang, Set<string>> = {
  en: new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'tell', 'that', 'the', 'their', 'there', 'to', 'us', 'what', 'when', 'where', 'which', 'who', 'with', 'you', 'your']),
  am: new Set(['አንድ', 'እና', 'እንዴት', 'እኔ', 'እኛ', 'ነው', 'ናቸው', 'ወይስ', 'ይህ', 'ያ', 'የሚ', 'በ', 'ለ', 'ከ', 'ስለ', 'ምን', 'ማን', 'መቼ', 'የት', 'አላችሁ', 'አለዎት']),
  om: new Set(['aa', 'an', 'fi', 'isaa', 'kan', 'maaliif', 'maaltu', 'maal', 'moo', 'taa', 'ti', 'waan', 'ykn', 'yuu', 'nu', 'na', 'isan', 'isaani', 'akka', 'akkaatam']),
};

const FOLLOW_UP_WORDS: Record<Lang, Set<string>> = {
  en: new Set(['more', 'another', 'details', 'else', 'yes', 'continue', 'next']),
  am: new Set(['ሌላ', 'ተጨማሪ', 'ዝርዝር', 'አዎ', 'ቀጥል', 'ቀጣይ']),
  om: new Set(['dabalataa', 'biraa', 'bal\'inaa', 'eeyyee', 'itti', 'fuuraa']),
};

const CANONICAL_WORDS: Record<string, string> = {
  program: 'programme',
  programs: 'programme',
  programmes: 'programme',
  shows: 'show',
  photos: 'photo',
  albums: 'album',
  tracks: 'track',
  recordings: 'recording',
  songs: 'song',
  events: 'event',
  announcements: 'announcement',
  articles: 'article',
  books: 'book',
  bookshops: 'bookshop',
  misssion: 'mission',
  missions: 'mission',
  ydcs: 'yemisrach',
  sagaleen: 'sagalee',
  misirachoo: 'missirachoo',
  ergamni: 'ergama',
  akkanatti: 'akkamitti',
  dhaggeeffadhaa: 'dhaggeeffachuu',
  buufadhaa: 'buufachuu',
  sagantaalee: 'sagantaa',
  organisations: 'organisation',
  organization: 'organisation',
  organizations: 'organisation',
  organising: 'organisation',
  organizing: 'organisation',
};

const jsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const jsonRecord = (value: unknown): Record<string, string> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v ?? '')]));
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')]));
  } catch {
    return {};
  }
};

export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => CANONICAL_WORDS[word] ?? word)
    .join(' ');
}

export function extractKeywords(value: string, lang: Lang): string[] {
  const stop = STOPWORDS[lang];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of normaliseText(value).split(' ')) {
    if (word.length < 2 || stop.has(word) || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
    if (words.length === 14) break;
  }
  return words;
}

export function isFollowUp(value: string, lang: Lang): boolean {
  const words = new Set(normaliseText(value).split(' '));
  return words.size <= 6 && FOLLOW_UP_WORDS[lang].size > 0 && [...words].some((word) => FOLLOW_UP_WORDS[lang].has(word));
}

export async function invalidateChatbotCache(): Promise<void> {
  await cacheDelete(
    KNOWLEDGE_CACHE_KEY,
    SETTINGS_CACHE_KEY,
    SUGGESTIONS_CACHE_KEY('en'),
    SUGGESTIONS_CACHE_KEY('am'),
    SUGGESTIONS_CACHE_KEY('om')
  );
}

export async function loadSettings(): Promise<ChatbotSettings> {
  const cached = await cacheGet<ChatbotSettings>(SETTINGS_CACHE_KEY);
  if (cached) return { ...DEFAULT_SETTINGS, ...cached };

  const rows = await queryAll<{ setting_key: string; setting_value: string }>(
    'SELECT setting_key, setting_value FROM chatbot_settings'
  );
  const raw = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  const number = (key: string, fallback: number) => {
    const parsed = Number(raw[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const languages = jsonArray(raw.enabled_languages).filter((lang): lang is Lang =>
    (LANGS as readonly string[]).includes(lang)
  );
  const settings: ChatbotSettings = {
    confidenceThreshold: Math.min(1, number('confidence_threshold', DEFAULT_SETTINGS.confidenceThreshold)),
    fuzzyThreshold: Math.min(1, number('fuzzy_threshold', DEFAULT_SETTINGS.fuzzyThreshold)),
    welcomeMessages: { ...DEFAULT_SETTINGS.welcomeMessages, ...jsonRecord(raw.welcome_messages) },
    fallbackMessages: { ...DEFAULT_SETTINGS.fallbackMessages, ...jsonRecord(raw.fallback_messages) },
    enabledLanguages: languages.length ? languages : [...LANGS],
    autoApproveContent: raw.auto_approve_content !== 'false',
    syncIntervalMinutes: number('sync_interval_minutes', DEFAULT_SETTINGS.syncIntervalMinutes),
    maxHistoryTurns: number('max_history_turns', DEFAULT_SETTINGS.maxHistoryTurns),
  };
  await cacheSet(SETTINGS_CACHE_KEY, settings);
  return settings;
}

function mapEntry(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    intentId: row.intent_id,
    intentName: row.intent_name ?? 'general',
    language: LANGS.includes(row.language as Lang) ? (row.language as Lang) : 'en',
    question: row.question,
    alternatives: jsonArray(row.alternative_questions),
    keywords: jsonArray(row.keywords),
    answer: row.answer,
    priority: Number(row.priority) || 0,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
  };
}

export async function loadKnowledge(): Promise<KnowledgeEntry[]> {
  const cached = await cacheGet<KnowledgeEntry[]>(KNOWLEDGE_CACHE_KEY);
  if (cached) return cached;

  const rows = await queryAll<KnowledgeRow>(
    `SELECT k.id, k.intent_id, i.name AS intent_name, k.language, k.question,
            k.alternative_questions, k.keywords, k.answer, k.priority, k.source_type, k.source_url
       FROM chatbot_knowledge k
       LEFT JOIN chatbot_intents i ON i.id = k.intent_id
      WHERE k.is_active = 1 AND k.sync_status = 'approved'
        AND (i.id IS NULL OR i.is_active = 1)
      ORDER BY k.priority DESC, k.created_at ASC`
  );
  const entries = rows.map(mapEntry);
  await cacheSet(KNOWLEDGE_CACHE_KEY, entries);
  return entries;
}

function phraseScore(query: string, entry: KnowledgeEntry): number {
  const phrases = [entry.question, ...entry.alternatives].map(normaliseText).filter(Boolean);
  if (!phrases.length) return 0;
  let best = 0;
  for (const phrase of phrases) {
    if (phrase === query || (query.length >= 8 && phrase.includes(query))) {
      best = 1;
      break;
    }
    const phraseWords = new Set(phrase.split(' '));
    const queryWords = new Set(query.split(' '));
    let overlap = 0;
    for (const word of queryWords) if (phraseWords.has(word)) overlap += 1;
    const ratio = overlap / Math.max(1, Math.min(phraseWords.size, queryWords.size));
    if (ratio > best) best = ratio;
  }
  return best;
}

function keywordScore(queryKeywords: string[], entry: KnowledgeEntry): number {
  if (!queryKeywords.length || !entry.keywords.length) return 0;
  const wanted = new Set(entry.keywords.map(normaliseText));
  let matched = 0;
  for (const word of queryKeywords) if (wanted.has(word)) matched += 1;
  return matched / Math.max(1, Math.min(queryKeywords.length, wanted.size));
}

export function findBestMatch(
  question: string,
  lang: Lang,
  settings: ChatbotSettings,
  entries: KnowledgeEntry[],
  contextIntentId?: string | null,
  excludeId?: string | null
): MatchResult | null {
  const query = normaliseText(question);
  if (!query) return null;

  const candidates = entries.filter((entry) => entry.language === lang && entry.id !== excludeId);
  if (!candidates.length) return null;

  const fuse = new Fuse(candidates, {
    keys: [
      { name: 'question', weight: 0.5 },
      { name: 'alternatives', weight: 0.25 },
      { name: 'keywords', weight: 0.25 },
    ],
    threshold: settings.fuzzyThreshold,
    ignoreLocation: true,
    includeScore: true,
  });
  const fuzzy = new Map<string, number>();
  for (const result of fuse.search(query)) {
    fuzzy.set(result.item.id, 1 - (result.score ?? 1));
  }

  const queryKeywords = extractKeywords(question, lang);
  let best: MatchResult | null = null;
  for (const entry of candidates) {
    const exact = phraseScore(query, entry);
    const keyword = keywordScore(queryKeywords, entry);
    const fuzzyValue = fuzzy.get(entry.id) ?? 0;
    const context = contextIntentId && entry.intentId === contextIntentId ? 0.08 : 0;
    const confidence = Math.min(1, exact * 0.35 + keyword * 0.45 + fuzzyValue * 0.2 + context + Math.min(0.05, entry.priority / 2000));
    if (!best || confidence > best.confidence) best = { entry, confidence };
  }

  if (!best || best.confidence < settings.confidenceThreshold) return null;
  return best;
}

export async function getSuggestions(lang: Lang, limit = 5): Promise<string[]> {
  const cached = await cacheGet<string[]>(SUGGESTIONS_CACHE_KEY(lang));
  if (cached) return cached.slice(0, limit);
  const entries = (await loadKnowledge()).filter(
    (entry) => entry.language === lang && entry.intentName !== 'greeting' && !entry.id.startsWith('chat-kb-greeting-')
  );
  const suggestions = entries
    .sort((a, b) => b.priority - a.priority || a.question.localeCompare(b.question))
    .slice(0, limit)
    .map((entry) => entry.question);
  await cacheSet(SUGGESTIONS_CACHE_KEY(lang), suggestions);
  return suggestions;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export async function getKnowledgeById(id: string): Promise<KnowledgeEntry | null> {
  const row = await queryOne<KnowledgeRow>(
    `SELECT k.id, k.intent_id, i.name AS intent_name, k.language, k.question,
            k.alternative_questions, k.keywords, k.answer, k.priority, k.source_type, k.source_url
       FROM chatbot_knowledge k LEFT JOIN chatbot_intents i ON i.id = k.intent_id
      WHERE k.id = ?`,
    [id]
  );
  return row ? mapEntry(row) : null;
}
