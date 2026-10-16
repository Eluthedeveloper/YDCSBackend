import { parseFile } from 'music-metadata';
import { MAX_ALBUM, MAX_ARTIST, MAX_TITLE } from './validate';

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
}

export const NO_TAGS: AudioTags = { title: null, artist: null, album: null };

function firstText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = firstText(entry);
      if (text) return text;
    }
  }
  return null;
}

export async function readAudioTags(filePath: string): Promise<AudioTags> {
  try {
    const { common } = await parseFile(filePath, { duration: false, skipCovers: true });
    return {
      title: firstText(common.title),
      artist: firstText(common.artist) ?? firstText(common.artists) ?? firstText(common.albumartist),
      album: firstText(common.album),
    };
  } catch {
    return NO_TAGS;
  }
}

export function fileNameStem(originalName: string): string {
  return originalName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim();
}

export interface TrackMetaInput {
  title: string | null;
  artist: string | null;
  album: string | null;
  originalName: string;
  tags: AudioTags;
}

export interface TrackMeta {
  title: string;
  artist: string | null;
  album: string | null;
}

export function resolveTrackMeta(input: TrackMetaInput): TrackMeta {
  const base = input.originalName.replace(/^.*[\\/]/, '');
  const stem = fileNameStem(input.originalName);
  const clientTitle = firstText(input.title);
  const clientArtist = firstText(input.artist);
  const clientAlbum = firstText(input.album);
  const copiedFromFile = clientTitle === stem || clientTitle === base;

  const title = (clientTitle && !copiedFromFile ? clientTitle : input.tags.title) || stem || 'Untitled';
  const artist = clientArtist || input.tags.artist;
  const album = clientAlbum || input.tags.album;

  return {
    title: title.slice(0, MAX_TITLE),
    artist: artist ? artist.slice(0, MAX_ARTIST) : null,
    album: album ? album.slice(0, MAX_ALBUM) : null,
  };
}
