import * as io from 'ioium/node';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { isCommentary, isCoverArt, probeStreams } from './local.js';
import { writePosterFromURL } from './poster.js';
import type { Episode, Movie } from './tmdb.js';
import { applyCleanPatterns } from './util.js';

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

/** Video codecs a browser can play from an MP4 without re-encoding */
export const browserVideoCodecs = ['h264', 'av1', 'vp9', 'vp8'];

/** Audio codecs a browser can play from an MP4 without re-encoding */
export const browserAudioCodecs = ['aac', 'mp3', 'flac', 'opus'];

export interface RemuxOptions {
	/**
	 * `auto` re-encodes audio the browser can't decode (E-AC-3, DTS, TrueHD, ...) and copies everything else.
	 * `copy` never re-encodes, which is faster but can produce a file with unplayable audio.
	 */
	audio?: 'auto' | 'copy';
	/** Bitrate used when the audio has to be re-encoded, in kbit/s */
	audioBitrate?: number;
	/** Replace `output` if it already exists */
	force?: boolean;
}

export interface RemuxResult {
	output: string;
	/** ffprobe index of the source video stream */
	video: number;
	/** ffprobe index of the source audio stream, or null when the file has no audio */
	audio: number | null;
	/** Whether the audio had to be re-encoded rather than copied */
	transcodedAudio: boolean;
}

export interface RemuxPlan extends RemuxResult {
	/** Arguments for `ffmpeg` */
	args: string[];
	/** Where ffmpeg writes. Rename it over `output` once ffmpeg exits successfully. */
	temp: string;
}

/**
 * Work out how to remux a file without running anything.
 *
 * {@link remuxToMp4} runs ffmpeg synchronously, which blocks for as long as the copy takes.
 * Long-lived processes should plan the remux and spawn ffmpeg themselves instead.
 */
export function planRemuxToMp4(input: string, output: string, options: RemuxOptions = {}): RemuxPlan {
	const { audio: audioMode = 'auto', audioBitrate = 192, force = false } = options;

	if (!force && existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);

	const streams = probeStreams(input);

	// Cover art shows up as a video stream, so skip it when looking for the real one
	const video = streams.find(s => s.codec_type === 'video' && !isCoverArt(s));
	if (!video) throw new Error(`No video stream in ${input}`);

	if (video.codec_name && !browserVideoCodecs.includes(video.codec_name)) {
		throw new Error(`Cannot remux ${video.codec_name} video; it would need to be re-encoded`);
	}

	const audioStreams = streams.filter(s => s.codec_type === 'audio');

	// Prefer a browser-playable main track so nothing has to be re-encoded
	const audio =
		audioStreams.find(s => s.codec_name && browserAudioCodecs.includes(s.codec_name) && !isCommentary(s)) ||
		audioStreams.find(s => !isCommentary(s)) ||
		audioStreams[0] ||
		null;

	const canCopyAudio = !audio || (!!audio.codec_name && browserAudioCodecs.includes(audio.codec_name));
	const transcodedAudio = !canCopyAudio && audioMode === 'auto';

	if (!canCopyAudio && audioMode === 'copy') {
		io.warn(`remux: copying ${audio.codec_name} audio, which most browsers cannot decode`);
	}

	/** Write somewhere else first so a crash can't leave a half-written file where a player would find it */
	const temp = output + '.part';

	const args = ['-y', '-i', input, '-map', `0:${video.index}`];

	if (audio) args.push('-map', `0:${audio.index}`);

	args.push('-c:v', 'copy');

	if (audio)
		args.push(...(transcodedAudio ? ['-c:a', 'aac', '-b:a', `${audioBitrate}k`, '-ac', '2'] : ['-c:a', 'copy']));

	args.push(
		'-sn',
		'-dn',
		'-map_chapters',
		'0',
		'-map_metadata',
		'0',
		// Put the index at the front so playback can start without reading the whole file
		'-movflags',
		'+faststart',
		'-f',
		'mp4',
		temp
	);

	io.debug(
		`remux: video ${video.codec_name}, audio ${audio?.codec_name ?? 'none'}${transcodedAudio ? ' -> aac' : ''}`
	);

	return { args, temp, output, video: video.index, audio: audio?.index ?? null, transcodedAudio };
}

/**
 * Remux a Matroska file into an MP4 that a browser can play.
 *
 * The video is always copied, so this is I/O bound rather than CPU bound.
 * `moov` is written at the front (`+faststart`) so players know the duration and can seek immediately —
 * Matroska has no equivalent, since its Cues always land at the end of the file.
 *
 * Subtitles and attachments are dropped: MP4 can't hold PGS/ASS, and fonts have nowhere to go.
 */
export function remuxToMp4(input: string, output: string, options: RemuxOptions = {}): RemuxResult {
	const { args, temp, ...result } = planRemuxToMp4(input, output, options);

	try {
		io.trackCommand(`Remuxing to ${basename(output)}`, 'ffmpeg', ...args);
		renameSync(temp, output);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}

	return result;
}
