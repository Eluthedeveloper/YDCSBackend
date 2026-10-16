import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAudioTags, fileNameStem, resolveTrackMeta, NO_TAGS } from './audioTags';

function ascii(text: string): number[] {
  return Array.from(text).map((c) => c.charCodeAt(0));
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function syncsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function id3Frame(id: string, text: string, version: 3 | 4): number[] {
  const data = version === 4 ? [0x03, ...utf8(text)] : [0x00, ...ascii(text)];
  const size = version === 4 ? syncsafe(data.length) : u32(data.length);
  return [...ascii(id), ...size, 0x00, 0x00, ...data];
}

function buildMp3(frames: number[][], version: 3 | 4): Buffer {
  const body = [...frames.flat(), ...new Array(64).fill(0)];
  const header = [0x49, 0x44, 0x33, version, 0x00, 0x00, ...syncsafe(body.length)];
  return Buffer.from([...header, ...body, ...new Array(64).fill(0xff)]);
}

const tags = (title: string | null, artist: string | null = null, album: string | null = null) => ({
  title,
  artist,
  album,
});

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-tags-'));
  await fs.writeFile(path.join(dir, 'v23.mp3'), buildMp3([
    id3Frame('TIT2', 'Plain Title', 3),
    id3Frame('TPE1', 'Plain Artist', 3),
    id3Frame('TALB', 'Plain Album', 3),
  ], 3));
  await fs.writeFile(path.join(dir, 'v24.mp3'), buildMp3([
    id3Frame('TIT2', 'ትርል ዘማር', 4),
    id3Frame('TPE1', 'የብርሃን መዘምራን', 4),
    id3Frame('TALB', 'አልበም አልበም', 4),
  ], 4));
  await fs.writeFile(path.join(dir, 'untagged.mp3'), Buffer.alloc(512, 0xff));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readAudioTags', () => {
  it('reads title, artist and album from ID3v2.3 tags', async () => {
    expect(await readAudioTags(path.join(dir, 'v23.mp3'))).toEqual(
      tags('Plain Title', 'Plain Artist', 'Plain Album')
    );
  });

  it('reads UTF-8 tags, so Amharic text survives', async () => {
    expect(await readAudioTags(path.join(dir, 'v24.mp3'))).toEqual(
      tags('ትርል ዘማር', 'የብርሃን መዘምራን', 'አልበም አልበም')
    );
  });

  it('reports no tags rather than throwing for an untagged file', async () => {
    expect(await readAudioTags(path.join(dir, 'untagged.mp3'))).toEqual(NO_TAGS);
  });

  it('reports no tags rather than throwing for a missing file', async () => {
    expect(await readAudioTags(path.join(dir, 'does-not-exist.mp3'))).toEqual(NO_TAGS);
  });
});

describe('fileNameStem', () => {
  it('drops the extension', () => {
    expect(fileNameStem('episode one.mp3')).toBe('episode one');
  });

  it('drops any directory the client included', () => {
    expect(fileNameStem('folder/track.flac')).toBe('track');
    expect(fileNameStem('C:\\Users\\me\\track.mp3')).toBe('track');
  });

  it('keeps intermediate dots', () => {
    expect(fileNameStem('ep.01.intro.mp3')).toBe('ep.01.intro');
  });
});

describe('resolveTrackMeta', () => {
  it('replaces a title copied from the file name with the tag title', () => {
    const meta = resolveTrackMeta({
      title: 'my song.mp3',
      artist: null,
      album: null,
      originalName: 'my song.mp3',
      tags: tags('Tagged Title', 'Tagged Artist'),
    });

    expect(meta).toEqual({ title: 'Tagged Title', artist: 'Tagged Artist', album: null });
  });

  it('replaces a title equal to the file name without its extension', () => {
    const meta = resolveTrackMeta({
      title: 'my song',
      artist: '',
      album: null,
      originalName: 'my song.mp3',
      tags: tags('Tagged Title', 'Tagged Artist'),
    });

    expect(meta).toEqual({ title: 'Tagged Title', artist: 'Tagged Artist', album: null });
  });

  it('keeps a title the client chose that differs from the file name', () => {
    const meta = resolveTrackMeta({
      title: 'Hand written title',
      artist: 'Hand written artist',
      album: 'Hand written album',
      originalName: 'my song.mp3',
      tags: tags('Tagged Title', 'Tagged Artist', 'Tagged Album'),
    });

    expect(meta).toEqual({
      title: 'Hand written title',
      artist: 'Hand written artist',
      album: 'Hand written album',
    });
  });

  it('falls back to the file name when nothing else has a title', () => {
    const meta = resolveTrackMeta({
      title: 'my song.mp3',
      artist: '',
      album: null,
      originalName: 'my song.mp3',
      tags: NO_TAGS,
    });

    expect(meta).toEqual({ title: 'my song', artist: null, album: null });
  });

  it('clamps tags that are wider than the columns', () => {
    const meta = resolveTrackMeta({
      title: null,
      artist: null,
      album: null,
      originalName: 'song.mp3',
      tags: tags('t'.repeat(400), 'a'.repeat(400), 'b'.repeat(400)),
    });

    expect(meta.title).toHaveLength(255);
    expect(meta.artist).toHaveLength(255);
    expect(meta.album).toHaveLength(255);
  });
});
