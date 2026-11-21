import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { ensureHlsPlaylist, HlsUnavailableError } from '../lib/hls';

dotenv.config();

const TRACKS_DIR = path.resolve(process.cwd(), 'uploads', 'tracks');
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

async function main() {
  let entries: string[];
  try {
    entries = await fs.readdir(TRACKS_DIR);
  } catch (error) {
    console.error(`Tracks upload directory not found: ${TRACKS_DIR}`);
    throw error;
  }

  const files = entries.filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  console.log(`Pre-generating HLS for ${files.length} track(s) in ${TRACKS_DIR}`);

  let done = 0;
  let failed = 0;

  await Promise.all(
    files.map(async (name) => {
      const stem = path.parse(name).name;
      try {
        await ensureHlsPlaylist(path.join(TRACKS_DIR, name), stem);
        done += 1;
        console.log(`[${done + failed}/${files.length}] ok   ${stem}`);
      } catch (error) {
        failed += 1;
        if (error instanceof HlsUnavailableError) console.error(`[hls] ${error.message}`);
        else console.error(`[hls] ${stem} failed:`, error);
        console.log(`[${done + failed}/${files.length}] fail ${stem}`);
      }
    })
  );

  console.log(`Done: ${done} packaged, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('HLS pre-generation failed:', error);
  process.exitCode = 2;
});
