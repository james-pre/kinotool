import { basename } from 'node:path';
import { styleText } from 'node:util';
import type { MediaType, NameInfo } from './common.js';
import { resolveNameInfo } from './name.js';

export interface Identity extends NameInfo {
	title: string;
	inputPath: string;
	key: string;
	fileName: string;
	type: MediaType;
	mkvTitle?: string;
}

export function identify(inputPath: string): Identity {
	const fileName = basename(inputPath);

	const type: MediaType = fileName.match(/S(\d{2})E(\d{2})(?:[-E](\d{2}))?/i) ? 'tv' : 'movie';

	const { title, year, episode, season }: NameInfo = resolveNameInfo(inputPath);

	let mkvTitle = undefined;

	if (type === 'tv') {
		mkvTitle = `${title} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
		return { inputPath, key: fileName, fileName, type, title, mkvTitle, year, season, episode };
	}

	return { inputPath, key: fileName, fileName, type, title, mkvTitle, year };
}

function* getFormatFields(ident: Identity): Generator<[label: string, value: unknown]> {
	yield ['Title', ident.title];
	yield ['Year', ident.year];
	yield ['Type', ident.type == 'movie' ? 'Movie' : 'TV Show'];

	if (ident.type == 'tv') {
		yield ['Season', ident.season];
		yield ['Episode', ident.episode];
	}
}

export function formatIdentity(ident: Identity): string {
	const fields = Array.from(getFormatFields(ident));

	const labelLength = Math.max(...fields.map(([label]) => label.length));

	let formatted = '';

	for (const [label, value] of fields) {
		const valueText =
			typeof value == 'string'
				? styleText('yellow', value)
				: typeof value == 'number'
					? Number.isFinite(value)
						? styleText('blue', value.toString())
						: styleText('red', '(invalid)')
					: styleText('dim', '(unknown)');

		formatted += `${label.padEnd(labelLength)} : ${valueText}\n`;
	}

	return formatted;
}
