import * as io from 'ioium/node';
import { renameSync, rmSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { isCommentary, isCoverArt, probeStreams, type ProbeStream } from './local.js';
import { writePosterFromURL } from './poster.js';
import type { Episode, Movie } from './tmdb.js';
import { applyCleanPatterns } from './util.js';

/**
 * MP4 has no equivalent of `mkvpropedit`, so every change here rewrites the container.
 * Streams are always copied, so it is I/O bound rather than CPU bound, but it is not free —
 * prefer passing metadata to {@link mkv.remuxToMp4} when you are producing the file anyway.
 */

export interface Track {
	/** ffprobe stream index, which is what `ffmpeg -map 0:<index>` expects */
	index: number;
	type: ProbeStream['codec_type'];
	codec: string;
	/** Whether this is cover art rather than a real video track */
	cover: boolean;
	default: boolean;
	channels?: number;
	language?: string;
	title?: string;
}

export interface Info {
	title?: string;
	tracks: Track[];
}

export function getInfo(file: string): Info {
	const streams = probeStreams(file);

	const tracks = streams.map<Track>(stream => ({
		index: stream.index,
		type: stream.codec_type,
		codec: stream.codec_name || 'unknown',
		cover: stream.codec_type === 'video' && isCoverArt(stream),
		default: !!stream.disposition?.default,
		channels: stream.channels,
		language: stream.tags?.language,
		title: stream.tags?.title,
	}));

	const out = io
		.trackCommand(
			'Getting title for ' + file,
			'ffprobe',
			'-v',
			'error',
			'-show_entries',
			'format_tags=title',
			'-of',
			'default=noprint_wrappers=1:nokey=1',
			file
		)
		.trim();

	return { title: out || undefined, tracks };
}

export interface MetadataChanges {
	/** Container title. Pass an empty string to clear it. */
	title?: string;
	/** Path to a JPEG/PNG to use as cover art, replacing any existing cover */
	cover?: string;
	/** ffprobe index of the audio track to mark as default */
	defaultAudio?: number;
}

/**
 * Apply metadata by rewriting the container in place.
 * The rewrite goes to a temporary file first so a failure can't leave a truncated file behind.
 */
export function setMetadata(file: string, changes: MetadataChanges, info: Info = getInfo(file)): void {
	const { title, cover, defaultAudio } = changes;

	if (title === undefined && !cover && defaultAudio === undefined) return;

	const video = info.tracks.find(track => track.type === 'video' && !track.cover);
	if (!video) throw new Error(`No video stream in ${file}`);

	const audio = info.tracks.filter(track => track.type === 'audio');

	const args = ['-y', '-i', file];
	if (cover) args.push('-i', cover);

	// Existing cover art is left unmapped so a new one doesn't end up alongside the old
	args.push('-map', `0:${video.index}`);
	for (const track of audio) args.push('-map', `0:${track.index}`);
	if (cover) args.push('-map', `${1}:v:0`);

	args.push('-c', 'copy');

	if (cover) args.push('-disposition:v:1', 'attached_pic');

	if (defaultAudio !== undefined) {
		audio.forEach((track, i) => args.push(`-disposition:a:${i}`, track.index === defaultAudio ? 'default' : '0'));
	}

	if (title !== undefined) args.push('-metadata', `title=${title}`);

	const temp = file + '.tmp' + (extname(file) || '.mp4');

	args.push('-movflags', '+faststart', temp);

	try {
		io.trackCommand('Updating ' + basename(file), 'ffmpeg', ...args);
		renameSync(temp, file);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
}

export function setContainerTitle(file: string, title: string): void {
	io.debug('title:', JSON.stringify(title));
	setMetadata(file, { title });
}

export function replaceCover(file: string, coverPath: string): void {
	io.debug(`thumbnail: embed ${basename(coverPath)}`);
	setMetadata(file, { cover: coverPath });
}

export function isAacMainAudio(track: Track): boolean {
	if (!/aac/i.test(track.codec)) return false;
	return !isCommentary({
		index: track.index,
		codec_type: 'audio',
		tags: track.title ? { title: track.title } : undefined,
	});
}

export function setAacDefaultAudio(file: string, info: Info = getInfo(file)): void {
	const audio = info.tracks.filter(track => track.type === 'audio');
	const target = audio.find(isAacMainAudio);

	if (!target) {
		io.warn('audio-default: no non-commentary AAC track found');
		return;
	}

	if (target.default && audio.every(track => track === target || !track.default)) {
		io.debug('audio-default: already correct');
		return;
	}

	io.debug('audio-default: track', target.index, `(${target.codec}, ${target.channels ?? '?'}ch)`);
	setMetadata(file, { defaultAudio: target.index }, info);
}

export function cleanContainerTitle(file: string, info: Info, cleanPatterns: RegExp[]): void {
	if (!info.title) return;

	const cleaned = applyCleanPatterns(info.title, cleanPatterns).trim();
	if (cleaned !== info.title) setContainerTitle(file, cleaned);
}

export async function setFromMovie(path: string, movie: Movie, posterPath?: string): Promise<void> {
	posterPath ||= await writePosterFromURL(
		{ title: movie.title, year: movie.release_date && new Date(movie.release_date).getFullYear() },
		'https://image.tmdb.org/t/p/w500' + movie.poster_path
	);

	// Title and cover in one pass, since each one on its own would rewrite the whole container
	setMetadata(path, { title: movie.title, cover: posterPath });
}

export async function setFromEpisode(path: string, ep: Episode, posterPath?: string): Promise<void> {
	posterPath ||= await writePosterFromURL(
		{ title: ep.name, year: ep.air_date && new Date(ep.air_date).getFullYear() },
		'https://image.tmdb.org/t/p/w300' + ep.still_path
	);

	setMetadata(path, { title: `S${ep.season_number} E${ep.episode_number} - ${ep.name}`, cover: posterPath });
}
