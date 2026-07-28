import * as io from 'ioium/node';
import { extname } from 'node:path';
import { type Config } from './config.js';
import { applyCleanPatterns } from './util.js';
import type { Episode, Movie } from './tmdb.js';
import { writePosterFromURL } from './poster.js';

export interface Track {
	id: number;
	type: 'video' | 'audio' | 'subtitles';
	codec: string;
	properties: {
		language?: string;
		language_ietf?: string;
		track_name?: string;
		default_track?: boolean;
		forced_track?: boolean;
		audio_channels?: number;
		audio_sampling_frequency?: number;
	};
}

export interface Attachment {
	id: number;
	file_name: string;
	content_type: string;
	size: number;
}

export interface Info {
	container?: { properties?: { title?: string } };
	tracks: Track[];
	attachments?: Attachment[];
}

export function getInfo(file: string): Info {
	const stdout = io.trackCommand('Getting info for ' + file, 'mkvmerge', '-J', file);
	return JSON.parse(stdout);
}

export function cleanTrackNames(file: string, info: Info, cleanPatterns: RegExp[]): void {
	const args: string[] = [];
	let changes = 0;

	for (const track of info.tracks) {
		const oldName = track.properties.track_name;
		if (oldName == null) continue;

		const newName = applyCleanPatterns(oldName, cleanPatterns).trim();
		if (newName === oldName) continue;

		args.push('--edit', `track:@${track.id}`, '--set', `name=${newName}`);
		io.debug(`clean: track ${track.id}:`, JSON.stringify(oldName), '->', JSON.stringify(newName));
		changes++;
	}

	if (changes > 0) io.trackCommand('Cleaning track names', 'mkvpropedit', file, ...args);
	else io.log('clean: no track name changes');
}

export function cleanContainerTitle(file: string, info: Info, cleanPatterns: RegExp[]): void {
	const title = info.container?.properties?.title;
	if (!title) return;

	const cleaned = applyCleanPatterns(title, cleanPatterns).trim();
	if (cleaned !== title) setContainerTitle(file, cleaned);
}

export function setAacDefaultAudio(file: string, info: Info): void {
	const audioTracks = info.tracks.filter(t => t.type === 'audio');
	const target = audioTracks.find(isAacMainAudio);

	if (!target) {
		io.warn('audio-default: no non-commentary AAC track found');
		return;
	}

	const args: string[] = [];
	for (const track of audioTracks) {
		args.push('--edit', `track:@${track.id}`, '--set', `flag-default=${track.id === target.id ? 1 : 0}`);
	}

	io.debug('audio-default: track', target.id, `(${target.codec}, ${target.properties.audio_channels ?? '?'}ch)`);
	io.trackCommand('Setting AAC as default audio', 'mkvpropedit', file, ...args);
}

export function isAacMainAudio(track: Track): boolean {
	if (!/aac/i.test(track.codec)) return false;

	const name = track.properties.track_name || '';
	if (/commentary|director|cast|crew|descriptive|description|audio description|ad\b/i.test(name)) return false;

	return true;
}

export function setContainerTitle(file: string, title: string): void {
	io.debug('title:', JSON.stringify(title));
	io.trackCommand('Setting container title', 'mkvpropedit', file, '--edit', 'info', '--set', `title=${title}`);
}

export function replaceCover(file: string, coverPath: string): void {
	const ext = extname(coverPath).toLowerCase();
	const isPng = ext === '.png';
	const attachmentName = isPng ? 'cover.png' : 'cover.jpg';
	const mime = isPng ? 'image/png' : 'image/jpeg';

	const args = [
		file,
		'--delete-attachment',
		'name:cover.jpg',
		'--delete-attachment',
		'name:cover.png',
		'--delete-attachment',
		'name:small_cover.jpg',
		'--delete-attachment',
		'name:small_cover.png',
		'--attachment-name',
		attachmentName,
		'--attachment-mime-type',
		mime,
		'--add-attachment',
		coverPath,
	];

	io.debug(`thumbnail: embed ${attachmentName}`);
	// mkvpropedit exits 1 on warnings (e.g. deleting a cover that isn't present); only 2 is a real error.
	io.trackCommand({ text: 'Embedding thumbnail', ignoreCode: [1] }, 'mkvpropedit', ...args);
}

export async function setFromMovie(path: string, movie: Movie, posterPath?: string) {
	setContainerTitle(path, movie.title);

	posterPath ||= await writePosterFromURL(
		{ title: movie.title, year: movie.release_date && new Date(movie.release_date).getFullYear() },
		'https://image.tmdb.org/t/p/w500' + movie.poster_path
	);

	replaceCover(path, posterPath);
}

export async function setFromEpisode(path: string, ep: Episode, posterPath?: string) {
	setContainerTitle(path, `S${ep.season_number} E${ep.episode_number} - ${ep.name}`);

	posterPath ||= await writePosterFromURL(
		{ title: ep.name, year: ep.air_date && new Date(ep.air_date).getFullYear() },
		'https://image.tmdb.org/t/p/w300' + ep.still_path
	);

	replaceCover(path, posterPath);
}
