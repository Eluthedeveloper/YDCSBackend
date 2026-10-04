import type { PoolConnection, Pool } from 'mysql2/promise';

/**
 * Ordered, append-only schema migrations. Each entry runs exactly once; applied
 * names are recorded in `schema_migrations`. Statements must be idempotent so a
 * partially-applied legacy install can still be upgraded in place.
 */
export interface Migration {
  name: string;
  up: (conn: PoolConnection) => Promise<void>;
}

const CREATE_TABLES: Migration[] = [
  {
    name: '001_create_users',
    up: async (conn) => {
      await conn.execute(`
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
    },
  },
  {
    // Installs created before token_version existed still need the column.
    // Duplicate-column (1060) and duplicate-key (1061) mean it is already there.
    name: '002_add_users_token_version',
    up: async (conn) => {
      try {
        await conn.execute(
          'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER role'
        );
      } catch (e: any) {
        if (e.errno !== 1060 && e.errno !== 1061) throw e;
      }
    },
  },
  {
    name: '003_create_programs',
    up: async (conn) => {
      await conn.execute(`
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
    },
  },
  {
    name: '004_create_tracks',
    up: async (conn) => {
      await conn.execute(`
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
    },
  },
  {
    name: '005_create_comments',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS comments (
          id VARCHAR(36) PRIMARY KEY,
          program_id VARCHAR(36) NOT NULL,
          guest_name VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '006_create_likes',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS likes (
          id VARCHAR(36) PRIMARY KEY,
          track_id VARCHAR(36) NOT NULL,
          fingerprint VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_like (track_id, fingerprint),
          FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '007_create_listens',
    up: async (conn) => {
      await conn.execute(`
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
    },
  },
];

const CREATE_INDEXES: Migration[] = [
  'CREATE INDEX idx_tracks_program ON tracks(program_id)',
  'CREATE INDEX idx_tracks_created ON tracks(created_at DESC)',
  'CREATE INDEX idx_tracks_sort ON tracks(program_id, sort_order)',
  'CREATE INDEX idx_tracks_type ON tracks(track_type)',
  'CREATE INDEX idx_programs_created ON programs(created_at DESC)',
  'CREATE INDEX idx_programs_creator ON programs(created_by)',
  'CREATE INDEX idx_comments_program ON comments(program_id)',
  'CREATE INDEX idx_comments_created ON comments(created_at DESC)',
  'CREATE INDEX idx_likes_track ON likes(track_id)',
  'CREATE INDEX idx_likes_fingerprint ON likes(fingerprint)',
  'CREATE INDEX idx_users_role ON users(role)',
  'CREATE INDEX idx_listens_track ON listens(track_id)',
  'CREATE INDEX idx_listens_program ON listens(program_id)',
  'CREATE INDEX idx_listens_created ON listens(created_at DESC)',
].map((sql) => ({
  name: `index:${sql.split(' ')[2]}`,
  up: async (conn: PoolConnection) => {
    try {
      await conn.execute(sql);
    } catch (e: any) {
      // 1061 = duplicate key name, i.e. the index already exists.
      if (e.errno !== 1061) throw e;
    }
  },
}));

export const MIGRATIONS: Migration[] = [...CREATE_TABLES, ...CREATE_INDEXES];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(191) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await pool.execute<any[]>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await migration.up(conn);
      await conn.execute('INSERT INTO schema_migrations (name) VALUES (?)', [migration.name]);
      await conn.commit();
      console.log(`Migration applied: ${migration.name}`);
    } catch (err) {
      await conn.rollback();
      throw new Error(`Migration "${migration.name}" failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }
}
