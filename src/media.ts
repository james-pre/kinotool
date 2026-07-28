import { basename } from 'node:path';
import { styleText } from 'node:util';
import { NameInfo } from './common.js';
import { resolveNameInfo } from './name.js';
import * as z from 'zod';

export const MediaMetadata = z.object({
	...NameInfo.shape,
	id: z.int().positive(),
	isTV: z.boolean(),
	mkvTitle: z.string().optional(),
});

export interface MediaMetadata extends z.infer<typeof MediaMetadata> {}

export interface LocalMedia extends MediaMetadata {
	inputPath: string;
	key: string;
}

export function fromPath(inputPath: string): LocalMedia {
	const fileName = basename(inputPath);

	const isTV = !!fileName.match(/S(\d{2})E(\d{2})(?:[-E](\d{2}))?/i),
		id = 0;

	const { title, year, episode, season }: NameInfo = resolveNameInfo(inputPath);

	let mkvTitle = undefined;

	if (isTV) {
		mkvTitle = `${title} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
		return { id, inputPath, key: fileName, title, mkvTitle, year, season, episode, isTV };
	}

	return { id, inputPath, key: fileName, title, mkvTitle, year, isTV };
}

function* getFormatFields(ident: MediaMetadata): Generator<[label: string, value: unknown]> {
	yield ['Title', ident.title];
	yield ['Year', ident.year];
	yield ['Type', ident.isTV ? 'TV Show' : 'Movie'];

	if (ident.isTV) {
		yield ['Season', ident.season];
		yield ['Episode', ident.episode];
	}
}

export function formatIdentity(ident: MediaMetadata): string {
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
