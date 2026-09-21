import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

let pool: mysql.Pool;

export async function initDB(): Promise<mysql.Pool> {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'audiostreaming',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role ENUM('super_admin', 'admin') NOT NULL,
      token_version INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Migrate existing installs: add token_version if the column is missing.
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER role`);
  } catch (e: any) {
    if (e.errno !== 1060 && e.errno !== 1061) {
      console.warn('Warning: users.token_version migration issue:', e.message);
    }
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS programs (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      cover_image VARCHAR(255),
      created_by VARCHAR(36) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS tracks (
      id VARCHAR(36) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      artist VARCHAR(255),
      album VARCHAR(255),
      duration DOUBLE DEFAULT 0,
      file_path VARCHAR(255) NOT NULL,
      program_id VARCHAR(36) NOT NULL,
      track_type ENUM('episode', 'single', 'mix', 'live'),
      sort_order INT DEFAULT 0,
      created_by VARCHAR(36) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id VARCHAR(36) PRIMARY KEY,
      program_id VARCHAR(36) NOT NULL,
      guest_name VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS likes (
      id VARCHAR(36) PRIMARY KEY,
      track_id VARCHAR(36) NOT NULL,
      fingerprint VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_like (track_id, fingerprint),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS listens (
      id VARCHAR(36) PRIMARY KEY,
      track_id VARCHAR(36) NOT NULL,
      program_id VARCHAR(36) NOT NULL,
      fingerprint VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const indexes = [
    { sql: 'CREATE INDEX idx_tracks_program ON tracks(program_id)', name: 'idx_tracks_program' },
    { sql: 'CREATE INDEX idx_tracks_created ON tracks(created_at DESC)', name: 'idx_tracks_created' },
    { sql: 'CREATE INDEX idx_tracks_sort ON tracks(program_id, sort_order)', name: 'idx_tracks_sort' },
    { sql: 'CREATE INDEX idx_tracks_type ON tracks(track_type)', name: 'idx_tracks_type' },
    { sql: 'CREATE INDEX idx_programs_created ON programs(created_at DESC)', name: 'idx_programs_created' },
    { sql: 'CREATE INDEX idx_programs_creator ON programs(created_by)', name: 'idx_programs_creator' },
    { sql: 'CREATE INDEX idx_comments_program ON comments(program_id)', name: 'idx_comments_program' },
    { sql: 'CREATE INDEX idx_comments_created ON comments(created_at DESC)', name: 'idx_comments_created' },
    { sql: 'CREATE INDEX idx_likes_track ON likes(track_id)', name: 'idx_likes_track' },
    { sql: 'CREATE INDEX idx_likes_fingerprint ON likes(fingerprint)', name: 'idx_likes_fingerprint' },
    { sql: 'CREATE INDEX idx_users_role ON users(role)', name: 'idx_users_role' },
    { sql: 'CREATE INDEX idx_listens_track ON listens(track_id)', name: 'idx_listens_track' },
    { sql: 'CREATE INDEX idx_listens_program ON listens(program_id)', name: 'idx_listens_program' },
    { sql: 'CREATE INDEX idx_listens_created ON listens(created_at DESC)', name: 'idx_listens_created' },
  ];

  for (const idx of indexes) {
    try {
      await pool.execute(idx.sql);
    } catch (e: any) {
      if (e.errno !== 1061) {
        console.warn(`Warning: Failed to create index ${idx.name}:`, e.message);
      }
    }
  }

  return pool;
}

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDB() first.');
  return pool;
}

export async function queryAll(sql: string, params: any[] = []): Promise<any[]> {
  const [rows] = await pool.execute(sql, params);
  return rows as any[];
}

export async function queryOne(sql: string, params: any[] = []): Promise<any | undefined> {
  const rows = await queryAll(sql, params);
  return rows[0];
}

export async function runSQL(sql: string, params: any[] = []) {
  await pool.execute(sql, params);
}
