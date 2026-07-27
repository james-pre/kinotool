import * as io from 'ioium/node';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { renameSync } from 'node:fs';
import type { NameInfo } from './common.js';

/** Release-junk tokens (quality, codec, audio, source, group) that mark non-title content. */
export const JUNK_TOKENS = [
	'2160p',
	'1080p',
	'720p',
	'480p',
	'uhd',
	'hd',
	'sd',
	'hdr',
	'hdr10',
	'dv',
	'sdr',
	'10bit',
	'8bit',
	'bluray',
	'brrip',
	'bdrip',
	'web',
	'webrip',
	'web-?dl',
	'hdtv',
	'dvdrip',
	'remux',
	'x264',
	'x265',
	'h264',
	'h265',
	'hevc',
	'avc',
	'aac',
	'ac3',
	'eac3',
	'dts',
	'dd',
	'dd\\+',
	'ddp',
	'truehd',
	'atmos',
	'flac',
	'opus',
	'mp3',
	'repack',
	'proper',
	'extended',
	'imax',
	'amzn',
	'nf',
	'dsnp',
	'hmax',
];

/** Matches a token that *is* a junk marker (anchored), used to find where the title ends. */
const JUNK_TOKEN = new RegExp(`^(${JUNK_TOKENS.join('|')})$`, 'i');

/** Drop everything from the first junk token onward; release metadata never precedes the title. */
function stripJunkTokens(tokens: string[]): string[] {
	let cut = tokens.findIndex(t => JUNK_TOKEN.test(t));
	if (cut === -1) cut = tokens.length;
	return tokens.slice(0, cut);
}

/**
 * Best-effort parse of title, year, season, and episode from a file path.
 *
 * Season/episode come from the SxxExx token in the file name. The title may live in the file name,
 * its parent dir, or grandparent (depending on library layout), so we walk up and take the first
 * component that yields a real title once season/episode/year/junk tokens are stripped.
 */
export function resolveNameInfo(path: string): NameInfo {
	const noExt = basename(path).replace(/\.[^.]+$/, '');

	const sxe = noExt.match(/S(\d{1,2})E(\d{1,3})(?:[-E]\d{1,3})?/i);
	const season = sxe ? Number(sxe[1]) : undefined;
	const episode = sxe ? Number(sxe[2]) : undefined;

	const home = homedir();
	let title = '',
		year: number | undefined;

	// Stop at the filesystem root, the home dir, or a library root (e.g. "Movies", "TV/Videos").
	for (let current = path; ; current = dirname(current)) {
		const parsed = parseTitle(current === path ? noExt : basename(current));
		year ??= parsed.year;
		if (parsed.title) {
			title = parsed.title;
			year = parsed.year ?? year;
			break;
		}

		const parent = dirname(current);
		if (parent === current || parent === home || /videos?|movies?/i.test(basename(parent))) break;
	}

	return { title, year, season, episode };
}

/** Strip year, season/episode, and junk tags from a single path component. */
export function parseTitle(raw: string): { title: string; year?: number } {
	const normalized = raw.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();

	// Only treat a (parens)/[bracketed] year as the release year; a bare 4-digit number is too
	// ambiguous (e.g. "Blade Runner 2049", "2001 A Space Odyssey") and is left in the title.
	const bracketed = normalized.match(/[([](19\d{2}|20\d{2})[)\]]/);
	const year = bracketed ? Number(bracketed[1]) : undefined;

	let stripped = normalized;
	if (bracketed) stripped = stripped.replace(bracketed[0], '');
	stripped = stripped
		.replace(/\bS\d{1,2}E\d{1,3}(?:[-E]\d{1,3})?\b/gi, '')
		.replace(/\bS\d{1,2}\b/gi, '')
		.replace(/\bseason[\s._-]*\d+\b/gi, '');

	// Cut at the first junk token rather than scrubbing inline, so trailing release metadata
	// (e.g. "...2160p.WEB-DL.x265...") doesn't leave fragments in the title.
	const title = stripJunkTokens(stripped.split(/\s+/).filter(Boolean)).join(' ').trim();

	return { title, year };
}

/**
 * Build a tidy file name: cut everything from the first release-junk token (quality, codec,
 * source, group) and join the meaningful tokens with underscores.
 */
export function cleanFileName(fileName: string): string {
	const ext = extname(fileName);
	const stem = fileName.slice(0, fileName.length - ext.length);

	const kept = stripJunkTokens(stem.split(/[.\s_]+/).filter(Boolean));
	if (!kept.length) return fileName; // nothing identifiable; leave it alone
	return kept.join('_') + ext.toLowerCase();
}

export function renameFile(file: string): string {
	const dir = dirname(file);
	const cleaned = cleanFileName(basename(file));
	const target = join(dir, cleaned);
	if (target === file) {
		io.debug(`rename: already clean ${basename(file)}`);
		return file;
	}

	io.debug(`rename: ${basename(file)} -> ${cleaned}`);
	renameSync(file, target);
	return target;
}
