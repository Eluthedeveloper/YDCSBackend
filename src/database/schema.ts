import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { runMigrations } from './migrations';

dotenv.config();

let pool: mysql.Pool | null = null;

/** Values mysql2 can bind to a placeholder. */
export type SqlParam = string | number | boolean | Date | Buffer | null;

/**
 * A result row. Mapped to `any` rather than `unknown` because mysql2's driver
 * types describe their rows as object literals, and callers legitimately read
 * whatever columns their SELECT listed. Anything narrower should pass a type
 * argument (`queryOne<{ count: number }>(...)`) rather than casting the result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export async function initDB(): Promise<mysql.Pool> {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'audiostreaming',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  await runMigrations(pool);
  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDB() first.');
  return pool;
}

export async function queryAll<T = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params);
  return rows as T[];
}

export async function queryOne<T = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
  const rows = await queryAll<T>(sql, params);
  return rows[0];
}

export async function runSQL(sql: string, params: SqlParam[] = []) {
  await getPool().execute(sql, params);
}

/**
 * Runs `fn` inside a single transaction, committing on success and rolling
 * back on any throw. Use for multi-statement writes that must not be left
 * half-applied (e.g. delete a user only after their content is gone).
 */
export async function withTransaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Test helper: inject a pool without running migrations. */
export function setPoolForTesting(testPool: mysql.Pool | null): void {
  pool = testPool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
