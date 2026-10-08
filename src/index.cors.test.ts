import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from './index';
import { closeRedis } from './cache/redis';
import { closePool } from './database/schema';

describe('server', () => {
  const { app } = createApp();

  afterAll(async () => {
    await Promise.all([closePool().catch(() => {}), closeRedis()]);
  });

  it('permits the listener fingerprint header so like requests are not blocked', async () => {
    const res = await request(app)
      .options('/api/public/tracks/abc/like')
      .set('Origin', 'https://yemisrachdimts.org')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-client-fingerprint');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'x-client-fingerprint'
    );
  });

  it('allows credentialed requests from a known origin', async () => {
    const res = await request(app)
      .get('/api/public/programs')
      .set('Origin', 'https://yemisrachdimts.org');

    // Status depends on the database being reachable; the CORS headers are
    // what this test is about.
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://yemisrachdimts.org'
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an unknown origin', async () => {
    const res = await request(app)
      .get('/api/public/programs')
      .set('Origin', 'https://attacker.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});