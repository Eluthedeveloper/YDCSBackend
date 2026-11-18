import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations';

interface FakeConnOptions {
  appliedNames?: string[];
  acquired?: number;
  failOn?: RegExp;
}

function fakeConn(opts: FakeConnOptions = {}) {
  const { appliedNames = [], acquired = 1, failOn } = opts;
  const calls: string[] = [];
  const conn = {
    execute: vi.fn(async (sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/GET_LOCK/.test(sql)) return [[{ acquired }], []];
      if (/FROM schema_migrations/.test(sql)) {
        return [appliedNames.map((name) => ({ name })), []];
      }
      if (failOn && failOn.test(sql)) throw new Error('syntax error');
      return [{ affectedRows: 0 }, []];
    }),
    release: vi.fn(),
  };
  return { conn, calls };
}

function fakePool(conn: unknown) {
  return {
    execute: vi.fn(async () => [{ affectedRows: 0 }, []]),
    getConnection: vi.fn(async () => conn),
  } as any;
}

describe('migration list', () => {
  it('has unique names, since schema_migrations is keyed on them', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('creates every table the app queries', () => {
    const source = MIGRATIONS.map((m) => m.name).join(' ');
    for (const table of ['users', 'programs', 'tracks', 'comments', 'likes', 'listens']) {
      expect(source).toContain(`create_${table}`);
    }
  });

  it('orders token_version before anything that depends on it', () => {
    const order = MIGRATIONS.map((m) => m.name);
    expect(order.indexOf('001_create_users')).toBeLessThan(order.indexOf('002_add_users_token_version'));
    expect(order.indexOf('002_add_users_token_version')).toBeLessThan(order.indexOf('003_create_programs'));
  });
});

describe('runMigrations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies only the migrations not already recorded', async () => {
    const { conn, calls } = fakeConn({ appliedNames: ['001_create_users'] });
    const pool = fakePool(conn);

    await runMigrations(pool);

    const applied = calls.filter((c) => /INSERT INTO schema_migrations/.test(c));
    expect(applied.length).toBe(MIGRATIONS.length - 1);
    expect(calls.some((c) => /CREATE TABLE IF NOT EXISTS users/.test(c))).toBe(false);
  });

  it('takes an advisory lock, records each migration, and releases the connection', async () => {
    const { conn, calls } = fakeConn();
    const pool = fakePool(conn);

    await runMigrations(pool);

    expect(calls.some((c) => /GET_LOCK/.test(c))).toBe(true);
    expect(calls.some((c) => /RELEASE_LOCK/.test(c))).toBe(true);
    expect(calls.filter((c) => /INSERT INTO schema_migrations/.test(c)).length).toBe(MIGRATIONS.length);
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('stops at the failing migration but releases the lock and connection', async () => {
    const { conn, calls } = fakeConn({ failOn: /CREATE TABLE IF NOT EXISTS tracks/ });
    const pool = fakePool(conn);

    await expect(runMigrations(pool)).rejects.toThrow(/"004_create_tracks" failed: syntax error/);

    // The three migrations before the failure were still recorded.
    expect(calls.filter((c) => /INSERT INTO schema_migrations/.test(c)).length).toBe(3);
    expect(calls.some((c) => /RELEASE_LOCK/.test(c))).toBe(true);
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it('refuses to run when the advisory lock cannot be acquired', async () => {
    const { conn } = fakeConn({ acquired: 0 });
    const pool = fakePool(conn);

    await expect(runMigrations(pool)).rejects.toThrow(/migration lock/);
    expect(conn.release).toHaveBeenCalledTimes(1);
  });
});
