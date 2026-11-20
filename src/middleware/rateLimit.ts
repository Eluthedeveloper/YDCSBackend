import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { rateLimitRedis } from '../cache/redis';

// Redis is a cache, not a hard dependency, but `passOnStoreError` only helps
// when a command *rejects*. A connection that is established yet no longer
// answers (a restarted container, a half-open socket) leaves the promise
// pending forever, and because this store sits in front of every /api route
// that hung the whole API — contact and chatbot included — until the backend
// was restarted. Racing each command against a short deadline turns that into
// an ordinary store error, which express-rate-limit then skips over.
const STORE_TIMEOUT_MS = 1000;

function withStoreTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Rate-limit Redis command timed out')),
      STORE_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function store(prefix: string) {
  if (!rateLimitRedis) return undefined;
  return new RedisStore({
    sendCommand: (...args: string[]) =>
      withStoreTimeout(
        rateLimitRedis!.call(...(args as [string, ...string[]])) as Promise<RedisReply>
      ),
    prefix: `rl:${prefix}:`,
  });
}

function limiter(opts: { prefix: string; windowMs: number; max: number; message: string }): RateLimitRequestHandler {
  const { prefix, windowMs, max, message } = opts;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: store(prefix),
    // Redis is a cache, not a hard dependency. Without this, a Redis restart or
    // OOM turns every rate-limited API route into a 500 until it recovers.
    passOnStoreError: true,
    message: { error: message },
  });
}

export const generalLimiter = limiter({
  prefix: 'general',
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests, please try again later.',
});

export const browseLimiter = limiter({
  prefix: 'browse',
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests, please try again later.',
});

// Audio/video reads. A player sends one request per play and one per seek, so
// the ceiling is far higher than the page limit — but a single IP can no longer
// hammer the media route without bound.
export const mediaLimiter = limiter({
  prefix: 'media',
  windowMs: 15 * 60 * 1000,
  max: 15000,
  message: 'Too many requests, please try again later.',
});

export const authLimiter = limiter({
  prefix: 'auth',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many login attempts, please try again later.',
});

export const writeLimiter = limiter({
  prefix: 'write',
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: 'Write limit reached, try again later.',
});

// File uploads after a successful login. Higher than writeLimiter because a
// bulk admin session legitimately pushes hundreds of small image/track
// finalize calls per hour; the old 50/hour write cap blocked sequential bulk
// uploads halfway through a batch.
export const uploadLimiter = limiter({
  prefix: 'upload',
  windowMs: 60 * 60 * 1000,
  max: 400,
  message: 'Upload limit reached, try again later.',
});


// Chunk requests are counted per chunk, so the ceiling has to cover the worst
// case the upload UI allows: 50 files of 100 MB each at the smallest chunk
// size is 10 000 requests, plus retries. The cap is still bounded per IP per
// hour, and every request is limited to one chunk of bytes.
export const chunkLimiter = limiter({
  prefix: 'chunk',
  windowMs: 60 * 60 * 1000,
  max: 25000,
  message: 'Upload limit reached, try again later.',
});

export const interactionLimiter = limiter({
  prefix: 'interaction',
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many actions, please try again later.',
});

export const contactLimiter = limiter({
  prefix: 'contact',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many messages, please try again later.',
});

// Each chat message is a paid upstream request, so this is tighter than the
// browse limit but loose enough for a real conversation (a visitor asking a
// dozen follow-up questions is still well inside it).
export const chatLimiter = limiter({
  prefix: 'chat',
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: 'Too many chat messages, please try again later.',
});
