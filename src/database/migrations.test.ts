import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations';
import type { PoolConnection } from 'mysql2/promise';

function fakeConn() {
  const calls: string[] = [];
  const conn = {
    execute: vi.fn(async (sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      return [{ affectedRows: 0 }, []];
    }),
  };
  return { conn: conn as unknown as PoolConnection, calls };
}

function fakePool(appliedNames: string[] = []) {
  const statements: string[] = [];
  return {
    statements,
    pool: {
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (/FROM schema_migrations/.test(sql)) {
          return [appliedNames.map((name) => ({ name })), []];
        }
        return [{ affectedRows: 0 }, []];
      }),
      getConnection: vi.fn(),
    } as any,
  };
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
    const { pool, statements } = fakePool(['001_create_users']);
    const conn = fakeConn();
    (pool as any).getConnection = vi.fn(async () => ({
      ...conn.conn,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    }));

    await runMigrations(pool);

    const applied = conn.calls.filter((c) => /INSERT INTO schema_migrations/.test(c));
    expect(applied.length).toBe(MIGRATIONS.length - 1);
    expect(conn.calls.some((c) => /CREATE TABLE IF NOT EXISTS users/.test(c))).toBe(false);
  });

  it('records each migration and wraps it in a transaction', async () => {
    const { pool } = fakePool();
    const conn = fakeConn();
    const tx = {
      ...conn.conn,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    (pool as any).getConnection = vi.fn(async () => tx);

    await runMigrations(pool);

    expect(tx.beginTransaction).toHaveBeenCalledTimes(MIGRATIONS.length);
    expect(tx.commit).toHaveBeenCalledTimes(MIGRATIONS.length);
    expect(tx.rollback).not.toHaveBeenCalled();
    expect(tx.release).toHaveBeenCalledTimes(MIGRATIONS.length);
  });

  it('rolls back and throws when a migration fails', async () => {
    const { pool } = fakePool();
    const tx = {
      execute: vi.fn(async (sql: string) => {
        if (/CREATE TABLE IF NOT EXISTS tracks/.test(sql)) throw new Error('syntax error');
        return [{ affectedRows: 0 }, []];
      }),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    (pool as any).getConnection = vi.fn(async () => tx);

    await expect(runMigrations(pool)).rejects.toThrow(/"004_create_tracks" failed: syntax error/);
    // Only the failing migration rolls back; the ones before it already
    // committed and are recorded, so a re-run resumes from there.
    expect(tx.rollback).toHaveBeenCalledTimes(1);
    expect(tx.commit).toHaveBeenCalledTimes(3);
  });

  it('releases the connection even when a migration throws', async () => {
    const { pool } = fakePool();
    const tx = {
      execute: vi.fn(async () => { throw new Error('boom'); }),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    };
    (pool as any).getConnection = vi.fn(async () => tx);

    await expect(runMigrations(pool)).rejects.toThrow();
    expect(tx.release).toHaveBeenCalledTimes(1);
  });
});
