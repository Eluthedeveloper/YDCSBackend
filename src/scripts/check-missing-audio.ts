import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { closePool, initDB, queryAll } from '../database/schema';

dotenv.config();

// Same root the stream route resolves against (see src/index.ts).
const TRACKS_DIR = path.resolve(process.cwd(), 'uploads', 'tracks');

interface TrackRow {
  id: string;
  title: string;
  file_path: string | null;
  program_title: string | null;
}

/**
 * Lists track rows whose audio file is missing from uploads/tracks (the cause
 * of the 404s on `<uuid>.stream`), plus any files on disk that no track row
 * references. Exits 1 when something is missing so it can gate a deploy check.
 *
 * Run with: npm run check:audio
 */
async function main() {
  await initDB();

  const rows = await queryAll<TrackRow>(`
    SELECT t.id, t.title, t.file_path, p.title AS program_title
    FROM tracks t
    LEFT JOIN programs p ON p.id = t.program_id
    ORDER BY t.created_at ASC
  `);

  let diskFiles: string[] = [];
  try {
    diskFiles = fs.readdirSync(TRACKS_DIR);
  } catch {
    console.warn(`Tracks upload directory not found: ${TRACKS_DIR}`);
  }

  // Uploads keep the original extension verbatim, so compare case-insensitively
  // exactly like resolveUploadFile() does.
  const onDisk = new Set(diskFiles.map((name) => name.toLowerCase()));
  const referenced = new Set<string>();
  const missing: TrackRow[] = [];

  for (const row of rows) {
    if (!row.file_path) {
      missing.push(row);
      continue;
    }
    const basename = path.basename(row.file_path).toLowerCase();
    referenced.add(basename);
    if (!onDisk.has(basename)) missing.push(row);
  }

  const unreferenced = diskFiles.filter((name) => !referenced.has(name.toLowerCase()));

  console.log(`Uploads directory:   ${TRACKS_DIR}`);
  console.log(`Tracks in database:  ${rows.length}`);
  console.log(`Audio files on disk: ${diskFiles.length}`);
  console.log('');

  if (missing.length > 0) {
    console.log(`MISSING audio files (${missing.length} row(s) point at a file not on disk):`);
    for (const row of missing) {
      const program = row.program_title ? `  [${row.program_title}]` : '';
      console.log(`  ${row.id}  "${row.title}"${program}  file_path=${row.file_path ?? '(none)'}`);
    }
    console.log('');
  } else {
    console.log('All track rows have a matching audio file.');
    console.log('');
  }

  if (unreferenced.length > 0) {
    console.log(`UNREFERENCED audio files (${unreferenced.length}, no track row points at them):`);
    for (const name of unreferenced) console.log(`  ${name}`);
    console.log('');
  }

  await closePool();
  process.exit(missing.length > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  console.error('Audio check failed:', err);
  await closePool().catch(() => {});
  process.exit(2);
});
