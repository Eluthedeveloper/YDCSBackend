import { Router } from 'express';
import { chatLimiter } from '../middleware/rateLimit';
import { asyncHandler } from '../lib/asyncHandler';
import { buildSystemInstruction } from '../lib/orgKnowledge';
import {
  CHAT_TOOL_DECLARATIONS,
  executeChatTool,
  type ChatFunctionCall,
} from '../lib/chatDatabase';

/**
 * Visitor chat, proxied to the Gemini API.
 *
 * The API key never leaves the server: the browser posts a short conversation
 * to `/api/chat` and this route adds the organisation knowledge plus the key.
 * That also keeps the key out of the bundle, where anyone could copy it.
 */

const router = Router();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// `gemini-2.5-flash` now answers 404 for keys created recently, and the
// current generation occasionally answers 503 while a model is hot. A short
// fallback list keeps a temporary spike from taking the assistant down.
//
// Read per request rather than at module load: the process may be started
// before the environment is finalised (tests, container entrypoints), and a
// missing value should fall back to the default rather than pin `undefined`.
function resolveModels(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash,gemini-3.8-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [primary, ...fallbacks.filter((m) => m !== primary)];
}

// One upstream attempt. The browser already waited for the request; a model
// that takes longer than this is not going to produce a useful answer.
const REQUEST_TIMEOUT_MS = 25_000;

const MAX_TURNS = 12;
const MAX_MESSAGE_CHARS = 1500;
const MAX_TOTAL_CHARS = 8000;

// A tool round is one model turn that asks for database content plus the call
// that consumes the result. Two rounds allow a search followed by a targeted
// follow-up (for example find an article, then look at its programme), while
// still bounding a model that wants to keep searching forever.
const MAX_TOOL_ROUNDS = 2;

// The visitor is waiting, so the whole exchange gets a deadline rather than
// three independent 25-second allowances. A tool query is local and fast; the
// time is almost all model latency.
const CONVERSATION_TIMEOUT_MS = 45_000;

const SUPPORTED_LANGS = new Set(['en', 'am', 'om']);

type ChatRole = 'user' | 'model';

export interface ChatTurn {
  role: ChatRole;
  text: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface GeminiContent {
  role: ChatRole;
  parts: GeminiPart[];
}

/**
 * Validates and normalises the conversation sent by the browser.
 *
 * Returns null when there is nothing safe to send. History is trimmed rather
 * than trusted: the client can post any array, and every extra turn is a token
 * the ministry pays for.
 */
export function normaliseTurns(raw: unknown): ChatTurn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const turns: ChatTurn[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { role, text } = item as { role?: unknown; text?: unknown };
    if (typeof text !== 'string') return null;

    // `assistant` is the word the UI uses; Gemini calls the same role `model`.
    const normalisedRole =
      role === 'user' ? 'user' : role === 'assistant' || role === 'model' ? 'model' : null;
    if (!normalisedRole) return null;

    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_MESSAGE_CHARS) return null;

    turns.push({ role: normalisedRole, text: trimmed });
  }

  if (turns.length === 0) return null;

  // Merge consecutive turns from the same speaker. Gemini accepts them, but
  // one message per turn is what the UI produces and what keeps the prompt
  // predictable.
  const merged: ChatTurn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else merged.push({ ...turn });
  }

  // Keep the newest turns, then drop a leading model greeting: Gemini expects
  // the conversation to open with the visitor.
  let windowed = merged.slice(-MAX_TURNS);
  while (windowed.length > 0 && windowed[0].role === 'model') windowed = windowed.slice(1);
  if (windowed.length === 0 || windowed[windowed.length - 1].role !== 'user') return null;

  // Strip the oldest turns until the whole prompt fits the token budget.
  let total = windowed.reduce((sum, t) => sum + t.text.length, 0);
  while (windowed.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= windowed[0].text.length;
    windowed = windowed.slice(1);
    while (windowed.length > 0 && windowed[0].role === 'model') {
      total -= windowed[0].text.length;
      windowed = windowed.slice(1);
    }
  }

  if (windowed.length === 0 || windowed[windowed.length - 1].role !== 'user') return null;
  return windowed;
}

interface GeminiAttempt {
  ok: boolean;
  text?: string;
  /** Raw model parts, kept so thought signatures survive the tool round-trip. */
  parts?: GeminiPart[];
  functionCalls?: ChatFunctionCall[];
  status?: number;
  detail?: string;
}

async function callModel(
  model: string,
  apiKey: string,
  contents: GeminiContent[],
  lang: string,
  timeoutMs: number
): Promise<GeminiAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header rather than ?key= so the secret cannot end up in a proxy log.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          role: 'user',
          parts: [{ text: buildSystemInstruction(lang) }],
        },
        contents,
        tools: [{ functionDeclarations: CHAT_TOOL_DECLARATIONS }],
        toolConfig: {
          functionCallingConfig: { mode: 'AUTO' },
        },
        generationConfig: {
          temperature: 0.4,
          topP: 0.9,
          // Long enough for a helpful answer, short enough that a runaway
          // generation cannot burn the ministry's quota.
          maxOutputTokens: 900,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
      signal: controller.signal,
    });

    const data: any = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        detail: data?.error?.message || `HTTP ${res.status}`,
      };
    }

    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      return { ok: false, status: 200, detail: `blocked: ${blockReason}` };
    }

    const rawParts: GeminiPart[] = Array.isArray(data?.candidates?.[0]?.content?.parts)
      ? (data.candidates[0].content.parts.filter(
          (part: unknown) => !!part && typeof part === 'object'
        ) as GeminiPart[])
      : [];

    const functionCalls: ChatFunctionCall[] = [];
    for (const part of rawParts) {
      const call = part.functionCall;
      if (call && typeof call.name === 'string' && call.name) {
        functionCalls.push({
          name: call.name,
          args: call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? call.args
            : undefined,
          id: typeof call.id === 'string' ? call.id : undefined,
        });
      }
    }

    const text = rawParts
      .filter((part) => typeof part.text === 'string' && !part.thought)
      .map((part) => part.text as string)
      .join('')
      .trim();

    // A function-call turn legitimately has no text. Only an empty response
    // with neither text nor a call is a failure.
    if (!text && functionCalls.length === 0) {
      return {
        ok: false,
        status: 200,
        detail: `empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? 'unknown'})`,
      };
    }

    return { ok: true, text, parts: rawParts, functionCalls };
  } catch (error) {
    return {
      ok: false,
      detail: controller.signal.aborted ? 'request timed out' : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one model through as many tool rounds as it needs (within the cap).
 *
 * The raw model parts are appended back to the conversation, including
 * `thoughtSignature`. Gemini 3 requires that signature on the function-call
 * turn; rebuilding the turn from just `{ name, args }` makes the follow-up
 * request fail or repeat the call.
 */
async function runConversation(
  model: string,
  apiKey: string,
  turns: ChatTurn[],
  lang: string
): Promise<GeminiAttempt> {
  const contents: GeminiContent[] = turns.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));

  const startedAt = Date.now();
  let toolRounds = 0;

  for (let step = 0; step <= MAX_TOOL_ROUNDS; step += 1) {
    const remaining = CONVERSATION_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      return { ok: false, status: 200, detail: 'conversation timed out' };
    }

    const attempt = await callModel(
      model,
      apiKey,
      contents,
      lang,
      Math.min(REQUEST_TIMEOUT_MS, remaining)
    );
    if (!attempt.ok) return attempt;

    const calls = attempt.functionCalls ?? [];
    if (calls.length === 0) return attempt;

    // The model ignored the "call each tool at most once" instruction. Prefer
    // any text it produced; otherwise let the fallback model try.
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      return attempt.text
        ? { ...attempt, functionCalls: [] }
        : { ok: false, status: 200, detail: 'model kept requesting tools' };
    }

    toolRounds += 1;

    contents.push({
      role: 'model',
      parts: attempt.parts && attempt.parts.length > 0
        ? attempt.parts
        : calls.map((call) => ({ functionCall: call })),
    });

    // Parallel calls share one user turn, which is the shape Gemini expects
    // when one model reply contains several function calls.
    const responses = await Promise.all(
      calls.map(async (call) => {
        const result = await executeChatTool(call);
        const functionResponse: Record<string, unknown> = {
          name: call.name,
          response: result,
        };
        if (call.id) functionResponse.id = call.id;
        return { functionResponse };
      })
    );

    contents.push({ role: 'user', parts: responses });
  }

  return { ok: false, status: 200, detail: 'tool loop exhausted' };
}

const UNAVAILABLE_REPLY =
  "I'm sorry, I can't answer that right now. Please try again in a moment, or contact us at info@yemisrachdimts.org.";

const BLOCKED_REPLY =
  "I'm sorry, I can't help with that question. For anything else, please contact us at info@yemisrachdimts.org or through the Contact page at /contact.";

router.post(
  '/',
  chatLimiter,
  asyncHandler(async (req, res) => {
    const turns = normaliseTurns(req.body?.messages);
    if (!turns) {
      return res.status(400).json({ error: 'A valid message is required.' });
    }

    const lang = typeof req.body?.lang === 'string' && SUPPORTED_LANGS.has(req.body.lang)
      ? req.body.lang
      : 'en';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[chat] GEMINI_API_KEY is not set; the assistant cannot answer.');
      return res.status(503).json({ error: 'The assistant is not available right now.' });
    }

    const models = resolveModels();

    let lastDetail = '';
    let blocked = false;

    for (const model of models) {
      const attempt = await runConversation(model, apiKey, turns, lang);

      if (attempt.ok) {
        // Chat answers are personal and time-sensitive; a shared cache would
        // leak one visitor's question to the next.
        res.set('Cache-Control', 'no-store');
        return res.json({ reply: attempt.text });
      }

      lastDetail = attempt.detail || lastDetail;

      console.warn(`[chat] model ${model} failed: ${attempt.detail}`);

      // A safety block is a content decision, not a model outage. Trying the
      // same question on another model would just work around the safety
      // filter, so answer calmly instead of falling back.
      if (attempt.detail?.startsWith('blocked:')) {
        blocked = true;
        break;
      }

      // Every other failure moves on to the next model: quota, overload,
      // timeouts, empty responses, tool-loop problems, and even errors that
      // look permanent for one model. A different model may still work.
    }

    if (blocked) {
      return res.json({ reply: BLOCKED_REPLY });
    }

    console.error(`[chat] all models failed. Last error: ${lastDetail}`);
    return res.status(502).json({ error: UNAVAILABLE_REPLY });
  })
);

export default router;
