import { basename, dirname, resolve } from 'node:path';
import * as z from 'zod';
import type { MediaType } from './common.js';
import { NameInfo } from './common.js';
import type { Config } from './config.js';
import { resolveNameInfo } from './name.js';

export const Override = z.object({
	...NameInfo.partial().shape,
	type: z.literal(['movie', 'tv', 'manual']).optional(),
	tmdbId: z.number().int().optional(),
	poster: z.string().optional(),
	mkvTitle: z.string().optional(),
});
export interface Override extends z.infer<typeof Override> {}

export interface Identity extends NameInfo {
	title: string;
	inputPath: string;
	key: string;
	fileName: string;
	type: MediaType;
	mkvTitle: string;
	override?: Override;
}

export function findOverride(inputPath: string, config: Config): Override | undefined {
	const media = config.media || {};
	const abs = resolve(inputPath);
	const fileName = basename(inputPath);
	const parentName = basename(dirname(inputPath));
	return media[abs] || media[inputPath] || media[fileName] || media[parentName];
}

export function identify(inputPath: string, config: Config): Identity {
	const fileName = basename(inputPath);

	const override = findOverride(inputPath, config) || {};
	const type: MediaType = fileName.match(/S(\d{2})E(\d{2})(?:[-E](\d{2}))?/i) ? 'tv' : 'movie';

	const { title, year, episode, season }: NameInfo = {
		...resolveNameInfo(inputPath),
		...override,
	};

	let { mkvTitle = title } = override;
	if (type === 'tv') {
		mkvTitle = override.mkvTitle || `${title} - S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
		return { inputPath, key: fileName, fileName, type, title, mkvTitle, year, season, episode, override };
	}

	return { inputPath, key: fileName, fileName, type, title, mkvTitle, year, override };
}
