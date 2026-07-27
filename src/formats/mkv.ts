import * as io from 'ioium/node';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { ResolvedMetadata } from '../common.js';
import { cacheDir, type Config } from '../config.js';
import type * as media from '../media.js';
import { applyCleanPatterns } from '../util.js';

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

export function cleanTrackNames(file: string, info: Info, config: Config): void {
	const patterns = (config.cleanPatterns || []).map(p => new RegExp(p, 'g'));
	const args: string[] = [];
	let changes = 0;

	for (const track of info.tracks) {
		const oldName = track.properties.track_name;
		if (oldName == null) continue;

		const newName = applyCleanPatterns(oldName, patterns).trim();
		if (newName === oldName) continue;

		args.push('--edit', `track:@${track.id}`, '--set', `name=${newName}`);
		io.debug(`clean: track ${track.id}:`, JSON.stringify(oldName), '->', JSON.stringify(newName));
		changes++;
	}

	if (changes > 0) io.trackCommand('Cleaning track names', 'mkvpropedit', file, ...args);
	else io.log('clean: no track name changes');
}

export function cleanContainerTitle(file: string, info: Info, config: Config): void {
	const title = info.container?.properties?.title;
	if (!title) return;

	const patterns = (config.cleanPatterns || []).map(p => new RegExp(p, 'g'));
	const cleaned = applyCleanPatterns(title, patterns).trim();
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

export async function getPoster(identity: media.Identity, metadata: ResolvedMetadata): Promise<string | null> {
	if (metadata.posterPath) {
		fs.accessSync(metadata.posterPath, fs.constants.R_OK);
		return metadata.posterPath;
	}

	if (!metadata.posterUrl) return null;

	fs.mkdirSync(cacheDir, { recursive: true });
	const cacheName = `${safeFileName(identity.title)}${identity.year ? `-${identity.year}` : ''}.poster.jpg`;
	const outPath = join(cacheDir, cacheName);

	try {
		fs.accessSync(outPath, fs.constants.R_OK);
		io.debug(`thumbnail: cached ${outPath}`);
		return outPath;
	} catch {
		// download below
	}

	io.debug(`thumbnail: download ${metadata.posterUrl}`);
	const res = await fetch(metadata.posterUrl);
	if (!res.ok) throw new Error(`poster download failed: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	fs.writeFileSync(outPath, bytes);
	return outPath;
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

function safeFileName(value: string): string {
	return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}
