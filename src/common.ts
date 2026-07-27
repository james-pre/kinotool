import * as z from 'zod';
import type { Config } from './config.js';
import type * as media from './media.js';

export const MediaType = z.literal(['movie', 'tv']);
export type MediaType = z.infer<typeof MediaType>;

export const NameInfo = z.object({
	title: z.string(),
	year: z.int().positive().optional(),
	episode: z.int().positive().optional(),
	season: z.int().positive().optional(),
});
export interface NameInfo extends z.infer<typeof NameInfo> {}

export interface ResolvedMetadata {
	title: string;
	year?: number;
	posterUrl?: string;
	posterPath?: string;
	source: SourceName | 'manual';
}

export const SourceName = z.literal(['local', 'tmdb', 'tvdb', 'fanart']);
export type SourceName = z.infer<typeof SourceName>;

export interface Source {
	name: SourceName;
	needsKey: boolean;
	resolve(identity: media.Identity, config: Config): Promise<ResolvedMetadata | null>;
}
