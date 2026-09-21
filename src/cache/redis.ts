import Redis from 'ioredis';

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

const DEFAULT_TTL = 300;

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
  value: any,
  ttl: number = DEFAULT_TTL
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
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
