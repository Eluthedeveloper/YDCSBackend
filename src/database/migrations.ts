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
  {
    name: '008_create_leaders',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS leaders (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL,
          quote VARCHAR(500),
          role_label VARCHAR(255),
          photo VARCHAR(255),
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '009_create_albums',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS albums (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description VARCHAR(500),
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '010_create_album_photos',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS album_photos (
          id VARCHAR(36) PRIMARY KEY,
          album_id VARCHAR(36) NOT NULL,
          caption VARCHAR(500),
          file_name VARCHAR(255) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '011_create_announcements',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS announcements (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          body TEXT,
          pinned TINYINT(1) NOT NULL DEFAULT 0,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '012_create_events',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS events (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          location VARCHAR(255),
          starts_at DATETIME NOT NULL,
          ends_at DATETIME,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '013_create_blog_posts',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS blog_posts (
          id VARCHAR(36) PRIMARY KEY,
          slug VARCHAR(255) UNIQUE NOT NULL,
          title VARCHAR(255) NOT NULL,
          excerpt VARCHAR(500),
          body MEDIUMTEXT,
          category VARCHAR(100),
          cover_image VARCHAR(255),
          published TINYINT(1) NOT NULL DEFAULT 1,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    // Extra photos shown inside the article body. Separate rows rather than a
    // JSON column so a single dropped photo is one DELETE, not a read-modify-
    // write of the whole post, and so the file can be unlinked by filename.
    name: '014_create_blog_images',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS blog_images (
          id VARCHAR(36) PRIMARY KEY,
          blog_post_id VARCHAR(36) NOT NULL,
          image VARCHAR(255) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    // Department tag on albums: NULL means "gallery only", one of the allowed
    // slugs mounts the album on that department's page. ALTER (not a 009 edit)
    // so databases that already applied 009 get the same schema.
    name: '015_create_album_department',
    up: async (conn) => {
      try {
        await conn.execute('ALTER TABLE albums ADD COLUMN department VARCHAR(64) NULL');
      } catch (e: any) {
        // 1060 = duplicate column: a fresh database that has since been given
        // the wider 009 definition already carries the column.
        if (e.errno !== 1060) throw e;
      }
      try {
        await conn.execute('CREATE INDEX idx_albums_department ON albums(department)');
      } catch (e: any) {
        if (e.errno !== 1061) throw e;
      }
    },
  },
  {
    // Hourly radio grid: one row per (day, hour), unique on the pair. Seeded
    // idempotently from the lineup that used to be hardcoded in the frontend
    // RadioSchedule component, so existing installs keep showing today's
    // programming until an admin edits it — fresh installs start from the
    // same baseline.
    name: '016_create_radio_schedule',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS radio_schedule (
          id VARCHAR(36) PRIMARY KEY,
          day ENUM('Mon','Tue','Wed','Thu','Fri','Sat','Sun') NOT NULL,
          hour TINYINT UNSIGNED NOT NULL,
          title VARCHAR(255) NOT NULL,
          host VARCHAR(255) NULL,
          category ENUM('worship','teaching','talk','music','live') NOT NULL DEFAULT 'talk',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_radio_day_hour (day, hour)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      for (const [day, hour, title, host, category] of SEED_RADIO_SCHEDULE) {
        await conn.execute(
          'INSERT IGNORE INTO radio_schedule (id, day, hour, title, host, category) VALUES (UUID(), ?, ?, ?, ?, ?)',
          [day, hour, title, host, category]
        );
      }
    },
  },
];

/**
 * The lineup previously hardcoded as `SCHEDULE` in the frontend
 * `RadioSchedule`. Kept here so the first DB-backed render shows exactly what
 * visitors were used to; admins then edit the real rows.
 */
const SEED_RADIO_SCHEDULE: Array<[string, number, string, string | null, string]> = [];

// Nightly recurring block, every day, hours 0-4
for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const) {
  for (const [hour, title, host, category] of [
    [0, 'Midnight Prayer & Worship', 'Prayer Team', 'worship'],
    [1, 'GAZ_TTB – Oromo Bible Study', 'Oromo Team', 'teaching'],
    [2, 'Morning Devotion (AMH_TTB)', 'Amharic Team', 'teaching'],
    [3, 'SOM_TTB – Somali Bible Study', 'Somali Team', 'teaching'],
    [4, 'TIR_TW – Tigrinya Worship', 'Tigrinya Team', 'worship'],
  ] as Array<[number, string, string, string]>) {
    SEED_RADIO_SCHEDULE.push([day, hour, title, host, category]);
  }
}
// Day-specific evening programs, verbatim from the old static grid.
SEED_RADIO_SCHEDULE.push(
  ['Mon', 5, "Children's Bible Hour", 'Sis. Helen', 'talk'],
  ['Mon', 6, 'Evening Gospel Music', 'DJ Mark', 'music'],
  ['Mon', 7, 'Night Intercession', 'Prayer Team', 'live'],
  ['Tue', 5, 'Youth Talk', 'Bro. Yonas', 'talk'],
  ['Tue', 6, 'Live Worship Hour', 'Worship Team', 'live'],
  ['Tue', 7, 'Scripture Reflections', 'Pastor Daniel', 'teaching'],
  ['Wed', 5, 'Women of Faith', 'Mrs. Esther', 'talk'],
  ['Wed', 6, 'Testimony Time', 'Mr. Samuel', 'talk'],
  ['Wed', 7, 'Midweek Revival', 'Pastor Daniel', 'live'],
  ['Thu', 5, 'Community Matters', 'Mr. Samuel', 'talk'],
  ['Thu', 6, 'Acoustic Worship', 'Worship Team', 'live'],
  ['Thu', 7, 'Evening Scriptures', 'Bro. John', 'teaching'],
  ['Fri', 5, 'Men of Valor', 'Mr. Samuel', 'talk'],
  ['Fri', 6, 'Live Friday Revival', 'Worship Team', 'live'],
  ['Fri', 7, 'Night Vigil Broadcast', 'Pastor Daniel', 'worship'],
  ['Fri', 8, 'Night Vigil Broadcast', 'Pastor Daniel', 'worship'],
  ['Sat', 5, 'Saturday School', 'Mrs. Esther', 'teaching'],
  ['Sat', 6, 'Worship Night Preview', 'Worship Team', 'live'],
  ['Sat', 7, 'Late Night Gospel', 'DJ Mark', 'music'],
  ['Sun', 2, 'Pre-Service Worship', 'Worship Team', 'worship'],
  ['Sun', 3, 'Sunday Main Service', 'Pastor Daniel', 'live'],
  ['Sun', 4, 'Sunday School Replay', 'Mrs. Esther', 'teaching'],
  ['Sun', 5, 'Afternoon Praise', 'Sis. Grace', 'worship'],
  ['Sun', 6, 'Evening Thanksgiving', 'Pastor Daniel', 'live'],
  ['Sun', 7, 'Close of Day Prayers', 'Mr. Samuel', 'worship'],
);

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
  'CREATE INDEX idx_leaders_sort ON leaders(sort_order, created_at)',
  'CREATE INDEX idx_album_photos_album ON album_photos(album_id, sort_order)',
  'CREATE INDEX idx_announcements_feed ON announcements(pinned DESC, created_at DESC)',
  'CREATE INDEX idx_events_starts ON events(starts_at DESC)',
  'CREATE INDEX idx_blog_slug ON blog_posts(slug)',
  'CREATE INDEX idx_blog_created ON blog_posts(created_at DESC)',
  'CREATE INDEX idx_blog_published ON blog_posts(published, created_at DESC)',
  'CREATE INDEX idx_blog_images_post ON blog_images(blog_post_id, sort_order)',
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
