import * as io from 'ioium/node';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCommentary, isCoverArt, probeStreams } from './local.js';

/** Video codecs a browser can play from an MP4 without re-encoding */
export const browserVideoCodecs = ['h264', 'hevc', 'av1', 'vp9', 'vp8'];

/** Audio codecs a browser can play from an MP4 without re-encoding */
export const browserAudioCodecs = ['aac', 'mp3', 'flac', 'opus'];

export interface Options {
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

export interface Result {
	output: string;
	/** ffprobe index of the source video stream */
	video: number;
	/** ffprobe index of the source audio stream, or null when the file has no audio */
	audio: number | null;
	/** Whether the audio had to be re-encoded rather than copied */
	transcodedAudio: boolean;
}

export interface Plan extends Result {
	/** Arguments for `ffmpeg` */
	args: string[];
	/** Where ffmpeg writes. Rename it over `output` once ffmpeg exits successfully. */
	temp: string;
}

/** Work out how to remux a Matroska file into an MP4 that a browser can play, without running anything. */
export function plan(input: string, output: string, options: Options = {}): Plan {
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
		io.warn('remux: copying', audio.codec_name, 'audio, which most browsers cannot decode');
	}

	/** Write somewhere else first so a crash can't leave a half-written file where a player would find it */
	const temp = output + '.part';

	const args = ['-y', '-i', input, '-map', `0:${video.index}`];

	if (audio) args.push('-map', `0:${audio.index}`);

	args.push('-c:v', 'copy');

	// Safari only plays HEVC tagged as hvc1, and ffmpeg defaults to hev1
	if (video.codec_name === 'hevc') args.push('-tag:v', 'hvc1');

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

/** Remuxes in progress by absolute output path */
const running = new Map<string, Promise<Result>>();

async function runInBackground(input: string, output: string, options: Options): Promise<Result> {
	const { args, temp, ...result } = plan(input, output, options);

	const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });

	try {
		const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
			ffmpeg.on('error', reject);
			ffmpeg.on('exit', (code, signal) => resolve([code, signal]));
		});

		if (code !== 0) throw new Error(`ffmpeg failed with code ${code}`);

		renameSync(temp, result.output);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}

	return result;
}

/**
 * Remux a Matroska file into an MP4 that a browser can play, running ffmpeg in the background.
 *
 * The video is always copied, so this is I/O bound rather than CPU bound.
 * `moov` is written at the front (`+faststart`) so players know the duration and can seek immediately —
 * Matroska has no equivalent, since its Cues always land at the end of the file.
 *
 * Subtitles and attachments are dropped: MP4 can't hold PGS/ASS, and fonts have nowhere to go.
 *
 * Asking for an output that is already being written returns the remux in progress.
 */
export function run(input: string, output: string, options: Options = {}): Promise<Result> {
	const key = resolve(output);

	const existing = running.get(key);
	if (existing) return existing;

	const remux = runInBackground(input, output, options).finally(() => running.delete(key));

	running.set(key, remux);
	return remux;
}

/** Like {@link run}, but blocks until ffmpeg is done. */
export function runSync(input: string, output: string, options: Options = {}): Result {
	const { args, temp, ...result } = plan(input, output, options);

	try {
		const ffmpeg = spawnSync('ffmpeg', args, { stdio: 'ignore' });
		if (ffmpeg.error) throw ffmpeg.error;
		if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed with ${ffmpeg.signal ?? 'code ' + ffmpeg.status}`);

		renameSync(temp, output);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}

	return result;
}
