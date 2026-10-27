import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { rateLimitRedis } from '../cache/redis';

function store(prefix: string) {
  if (!rateLimitRedis) return undefined;
  return new RedisStore({
    sendCommand: (...args: string[]) =>
      rateLimitRedis!.call(...(args as [string, ...string[]])) as Promise<RedisReply>,
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


export const chunkLimiter = limiter({
  prefix: 'chunk',
  windowMs: 60 * 60 * 1000,
  max: 3000,
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
