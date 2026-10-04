process.env.JWT_SECRET = 'test-secret-do-not-use-anywhere-else';
process.env.NODE_ENV = 'test';
// The cache is exercised through its own module mock, never a live Redis.
process.env.REDIS_ENABLED = 'false';
