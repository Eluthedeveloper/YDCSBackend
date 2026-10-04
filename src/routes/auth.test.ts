import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  runSQL: vi.fn(),
  withTransaction: vi.fn(),
  // Rows returned by the SELECT that withTransaction's callback issues after
  // updating the user.
  txSelect: vi.fn(),
}));

vi.mock('../database/schema', () => ({
  queryAll: db.queryAll,
  queryOne: db.queryOne,
  runSQL: db.runSQL,
  withTransaction: db.withTransaction,
  getPool: () => ({
    getConnection: async () => ({
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(),
      release: vi.fn(), execute: db.runSQL,
    }),
  }),
  initDB: vi.fn(),
  closePool: vi.fn(),
}));

const { createApp } = await import('../index');

const SECRET = 'test-secret-do-not-use-anywhere-else';

const SUPER_ADMIN = {
  id: 'user-super',
  username: 'superadmin',
  email: 'superadmin@audio.com',
  password: '',
  role: 'super_admin',
  token_version: 0,
};

const PLAIN_ADMIN = {
  id: 'user-admin',
  username: 'admin',
  email: 'admin@audio.com',
  password: '',
  role: 'admin',
  token_version: 0,
};

let app: ReturnType<typeof createApp>['app'];

/**
 * Stacks a test-specific query rule on top of the auth middleware's own
 * token_version lookup, which `authenticate` runs on every authenticated
 * request. Overriding queryOne without keeping that rule makes every call 401.
 * The override wins where both match, so a test can simulate a version bump.
 */
function mockQuery(overrides?: (sql: string, params: unknown[]) => unknown) {
  db.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    // await matters: an async override resolves to undefined, which must fall
    // through to the default rule rather than look like a matched rule.
    const custom = await overrides?.(sql, params);
    if (custom !== undefined) return custom;
    if (/SELECT id, token_version FROM users WHERE id/.test(sql)) {
      return { id: params[0], token_version: 0 };
    }
    return undefined;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  SUPER_ADMIN.password = await bcrypt.hash('correct-horse', 4);
  PLAIN_ADMIN.password = await bcrypt.hash('correct-horse', 4);
  db.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/SELECT \* FROM users WHERE username/.test(sql)) {
      const found = [SUPER_ADMIN, PLAIN_ADMIN].find((u) => u.username === params[0]);
      return found ? { ...found } : undefined;
    }
    if (/FROM users WHERE id = \?/.test(sql)) {
      return { id: params[0], token_version: 0 };
    }
    if (/COUNT\(\*\).*programs.*created_by/s.test(sql)) {
      return { programs: 0, tracks: 0 };
    }
    return undefined;
  });
  db.runSQL.mockResolvedValue(undefined);
  // mysql2's execute resolves to [rows, fields]; the handler destructures it.
  db.txSelect.mockResolvedValue({
    id: 'user-admin',
    username: 'admin',
    email: 'admin@audio.com',
    role: 'admin',
    token_version: 0,
  });
  db.withTransaction.mockImplementation(async (fn: (c: unknown) => unknown) =>
    fn({
      execute: async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT/i.test(sql)) return [[await db.txSelect(sql, params)], []];
        await db.runSQL(sql, params);
        return [{ affectedRows: 1 }, []];
      },
    })
  );
  ({ app } = createApp());
});

function tokenFor(user: { id: string; username: string; role: string }, tokenVersion = 0) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tokenVersion },
    SECRET,
    { expiresIn: '1h' }
  );
}

function cookieHeader(token: string) {
  return `ydcs_session=${token}`;
}

describe('POST /api/auth/login', () => {
  it('sets an httpOnly cookie and keeps the token out of the response body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'superadmin', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'superadmin', role: 'super_admin' });

    // The whole point of the cookie: no JS-readable copy anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain('eyJ');
    expect(res.body.token).toBeUndefined();

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('ydcs_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
  });

  it('never returns the password hash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'superadmin', password: 'correct-horse' });

    expect(res.body.user.password).toBeUndefined();
  });

  it('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'superadmin', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('rejects an unknown user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'correct-horse' });

    expect(res.status).toBe(401);
  });

  it('requires both fields', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'superadmin' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/auth/login credentials with markup characters', () => {
  it('accepts a password containing & and < without corrupting it', async () => {
    // This is the regression test for the removed body sanitizer, which used to
    // HTML-escape every field and so could never hash a password containing
    // these characters back to the same value.
    const awkward = 'pa&ss<word>"quote';
    PLAIN_ADMIN.password = await bcrypt.hash(awkward, 4);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: awkward });

    expect(res.status).toBe(200);
  });

  it('rejects the escaped form of that same password', async () => {
    // Proves the value is compared raw rather than against an escaped variant.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'pa&amp;ss&lt;word&gt;' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid cookie', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-super');
  });

  it('rejects a request with no cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  it('rejects a tampered token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader('not.a.jwt'));

    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { id: SUPER_ADMIN.id, username: SUPER_ADMIN.username, role: 'super_admin', tokenVersion: 0 },
      'attacker-secret',
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(forged));

    expect(res.status).toBe(401);
  });

  it('rejects a token whose role was escalated to super_admin', async () => {
    const tampered = jwt.sign(
      { id: PLAIN_ADMIN.id, username: PLAIN_ADMIN.username, role: 'super_admin', tokenVersion: 0 },
      SECRET,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(tampered));

    // Signed correctly, but the subject no longer matches a super_admin row,
    // so the role claim cannot be used on its own.
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('user-admin');
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign(
      { id: SUPER_ADMIN.id, username: SUPER_ADMIN.username, role: 'super_admin', tokenVersion: 0 },
      SECRET,
      { expiresIn: '-1s' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(expired));

    expect(res.status).toBe(401);
  });
});

describe('session revocation', () => {
  it('rejects a token issued before the version bump', async () => {
    mockQuery(async (sql: string) =>
      /FROM users WHERE id/.test(sql) ? { id: 'user-super', token_version: 3 } : undefined
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN, 0)));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });
});

describe('PUT /api/auth/me', () => {
  it('rejects a password shorter than the minimum', async () => {
    const res = await request(app)
      .put('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8/);
  });

  it('rejects an invalid email', async () => {
    const res = await request(app)
      .put('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('rejects a username that is already taken', async () => {
    mockQuery(async (sql: string) => {
      if (/SELECT id FROM users WHERE username/.test(sql)) return { id: 'user-super' };
      if (/FROM users WHERE id/.test(sql)) return { id: 'user-admin', token_version: 0 };
      return undefined;
    });

    const res = await request(app)
      .put('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ username: 'superadmin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already taken/i);
  });

  it('bumps token_version and re-issues the cookie on a password change', async () => {
    db.txSelect.mockResolvedValue({
      id: 'user-admin',
      username: 'admin',
      email: 'admin@audio.com',
      role: 'admin',
      token_version: 1,
    });

    const res = await request(app)
      .put('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ password: 'a-brand-new-password' });

    expect(res.status).toBe(200);

    const updateCall = db.runSQL.mock.calls.find((c) => /UPDATE users SET/.test(c[0] as string));
    expect(updateCall?.[0]).toMatch(/token_version = token_version \+ 1/);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('ydcs_session='))).toBe(true);
  });

  it('does not bump token_version for a username-only change', async () => {

    const res = await request(app)
      .put('/api/auth/me')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ username: 'admin2' });

    expect(res.status).toBe(200);
    const updateCall = db.runSQL.mock.calls.find((c) => /UPDATE users SET/.test(c[0] as string));
    expect(updateCall?.[0]).not.toMatch(/token_version/);
  });
});

describe('POST /api/auth (create user)', () => {
  it('requires super admin', async () => {
    const res = await request(app)
      .post('/api/auth')
      .set('Cookie', cookieHeader(tokenFor(PLAIN_ADMIN)))
      .send({ username: 'newbie', email: 'n@a.com', password: 'longenough', role: 'admin' });

    expect(res.status).toBe(403);
  });

  it('rejects a password under the new minimum', async () => {
    const res = await request(app)
      .post('/api/auth')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)))
      .send({ username: 'newbie', email: 'n@a.com', password: 'sixchr', role: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8/);
  });

  it('rejects an invalid role', async () => {
    const res = await request(app)
      .post('/api/auth')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)))
      .send({ username: 'newbie', email: 'n@a.com', password: 'longenough', role: 'root' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid role/);
  });

  it('reports a duplicate as 409 rather than a generic 400', async () => {
    db.runSQL.mockRejectedValue(Object.assign(new Error('duplicate'), { errno: 1062 }));

    const res = await request(app)
      .post('/api/auth')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)))
      .send({ username: 'newbie', email: 'n@a.com', password: 'longenough', role: 'admin' });

    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/auth/:id', () => {
  it('refuses to delete the caller', async () => {
    const res = await request(app)
      .delete(`/api/auth/${SUPER_ADMIN.id}`)
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('refuses to delete a user who still owns content', async () => {
    // Reassigning would silently misattribute their work; the FK is RESTRICT
    // anyway, so the old code's UPDATE-then-DELETE could only half-succeed.
    mockQuery(async (sql: string) => {
      if (/COUNT\(\*\).*programs/s.test(sql)) return { programs: 3, tracks: 41 };
      if (/SELECT id, username FROM users/.test(sql)) return { id: 'user-admin', username: 'admin' };
      return undefined;
    });

    const res = await request(app)
      .delete('/api/auth/user-admin')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/owns content/i);
    expect(db.runSQL).not.toHaveBeenCalledWith('DELETE FROM users WHERE id = ?', expect.anything());
  });

  it('deletes a user with no content', async () => {
    mockQuery(async (sql: string) => {
      if (/COUNT\(\*\).*programs/s.test(sql)) return { programs: 0, tracks: 0 };
      if (/SELECT id, username FROM users/.test(sql)) return { id: 'user-admin', username: 'admin' };
      return undefined;
    });

    const res = await request(app)
      .delete('/api/auth/user-admin')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)));

    expect(res.status).toBe(200);
    expect(db.runSQL).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?', ['user-admin']);
  });

  it('returns 404 for a user that does not exist', async () => {
    mockQuery(async (sql: string) =>
      /COUNT\(\*\).*programs/s.test(sql) ? { programs: 0, tracks: 0 } : undefined
    );

    const res = await request(app)
      .delete('/api/auth/ghost')
      .set('Cookie', cookieHeader(tokenFor(SUPER_ADMIN)));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => /ydcs_session=;/i.test(c))).toBe(true);
  });
});
