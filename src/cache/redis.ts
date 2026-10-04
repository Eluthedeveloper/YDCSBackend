import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redis: Redis | null = null;

if (process.env.REDIS_ENABLED === 'true') {
  redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
    retryStrategy(times: number) {
      // Keep reconnecting with a capped exponential backoff instead of giving
      // up permanently, so the app recovers once Redis comes back without a
      // restart. The cache is non-critical (see cacheGet) either way.
      return Math.min(500 * Math.pow(2, Math.min(times, 6)), 30000);
    },
  });

  redis.on('connect', () => {
    console.log('Redis connected');
  });

  redis.on('error', (err) => {
    console.warn('Redis error:', err.message);
  });

} else {
  console.log('Redis disabled. Running without cache.');
}

export default redis;

/**
 * A separate connection for the rate limiter. `rate-limit-redis` pipelines a
 * burst of INCR/PEXPIRE round trips and blocks the shared cache client while
 * it does, which would let a burst of auth attempts stall every cached read.
 */
export const rateLimitRedis: Redis | null = redis
  ? redis.duplicate()
  : null;

if (rateLimitRedis) {
  rateLimitRedis.on('error', (err) => {
    console.warn('Rate-limit Redis error:', err.message);
  });
}

export const DEFAULT_TTL = 300;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttl: number = DEFAULT_TTL
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {}
}

/** Deletes specific keys. Preferred over a pattern scan on hot paths. */
export async function cacheDelete(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {}
}

export async function cacheInvalidate(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    let cursor = '0';
    const keysToDelete: string[] = [];
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );
      cursor = nextCursor;
      keysToDelete.push(...keys);
    } while (cursor !== '0');

    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }
  } catch {}
}

/**
 * Closes both connections. Called on shutdown and in tests; without it the
 * rate-limit duplicate keeps the event loop alive after the server is done.
 */
export async function closeRedis(): Promise<void> {
  const clients = [rateLimitRedis, redis].filter((c): c is Redis => c !== null);
  await Promise.all(
    clients.map((client) =>
      client.status === 'end' ? Promise.resolve() : client.quit().catch(() => {})
    )
  );
}
