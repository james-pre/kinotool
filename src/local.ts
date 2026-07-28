import * as io from 'ioium/node';
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, type Config } from './config.js';
import type * as media from './media.js';

/** Title from the file name: drop extension, swap separators for spaces, tidy whitespace. */
export function titleFromFileName(fileName: string): string {
	return fileName
		.replace(/\.[^.]+$/, '')
		.replace(/[_.]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Total duration of a media file in seconds, or null if ffprobe can't determine it. */
export function probeDuration(file: string): number | null {
	const out = io
		.trackCommand(
			'Probing duration',
			'ffprobe',
			'-v',
			'error',
			'-show_entries',
			'format=duration',
			'-of',
			'default=noprint_wrappers=1:nokey=1',
			file
		)
		.trim();
	const seconds = Number(out);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function safeFileName(value: string): string {
	return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

/**
 * Pick a representative frame and write it to the cache as a JPEG.
 */
export function extractFrame(
	file: string,
	identity: media.LocalMedia,
	thumbnailSeconds: number,
	thumbnailPercent: number
): string {
	mkdirSync(cacheDir, { recursive: true });
	const outPath = join(cacheDir, `${safeFileName(identity.key)}.frame.jpg`);

	const duration = probeDuration(file);
	let seek = thumbnailSeconds;
	if (duration) {
		const percentSeek = (duration * thumbnailPercent) / 100;
		// Stay within [5%, 90%] so very long/short files still get a real frame.
		seek = Math.min(Math.max(percentSeek, duration * 0.05), duration * 0.9);
	}

	io.debug(`local: frame at ${seek.toFixed(1)}s${duration ? ` of ${duration.toFixed(0)}s` : ''}`);
	io.trackCommand(
		'Extracting frame',
		'ffmpeg',
		'-y',
		'-ss',
		seek.toFixed(3),
		'-i',
		file,
		'-frames:v',
		'1',
		'-q:v',
		'2',
		outPath
	);

	accessSync(outPath, fsConstants.R_OK);
	return outPath;
}
