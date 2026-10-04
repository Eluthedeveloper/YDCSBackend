import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { rateLimitRedis } from '../cache/redis';

// A shared in-process store silently resets on restart and is per-instance, so
// scaling out gives every replica its own fresh counter and any deploy hands
// attackers a fresh budget. Redis keeps the budget consistent across replicas
// and restarts; without Redis we fall back to memory, which is at least correct
// for a single instance.
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
