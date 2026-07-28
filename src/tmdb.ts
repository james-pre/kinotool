import type * as tmdb from 'tmdb-ts';
import { TMDB } from 'tmdb-ts';
import type { NameInfo } from './common.js';
import { normalizeTitle } from './util.js';
import * as z from 'zod';

export let api: TMDB;

export function setTmdbToken(token: string) {
	api = new TMDB(token);
}

export async function resolveTMDB(identity: NameInfo): Promise<tmdb.MovieWithMediaType | tmdb.TVWithMediaType | null> {
	const { results } = await api.search.multi({
		query: normalizeTitle(identity.title),
		language: 'en-US',
		page: 1,
		include_adult: true,
	});

	const first = results.find(r => r.media_type !== 'person');

	if (!first) return null;

	return first;
}

export const Movie = z.object({
	id: z.int().positive(),
	title: z.string(),
	overview: z.string(),
	release_date: z.coerce.date(),
	adult: z.boolean(),
	poster_path: z.string().nullish(),
	backdrop_path: z.string().nullish(),
});

export interface MovieInit extends z.input<typeof Movie> {}
export interface Movie extends z.infer<typeof Movie> {}

export const Episode = z.object({
	id: z.int(),
	season_number: z.int(),
	episode_number: z.int(),
	air_date: z.coerce.date(),
	name: z.string(),
	still_path: z.string().nullish(),
});

export interface EpisodeInit extends z.input<typeof Episode> {}
export interface Episode extends z.infer<typeof Episode> {}

export const Season = z.object({
	id: z.int(),
	season_number: z.int(),
	air_date: z.coerce.date(),
	name: z.string(),
	overview: z.string(),
	poster_path: z.string().nullish(),
	episodes: Episode.array().optional(),
});

export interface SeasonInit extends z.input<typeof Season> {}
export interface Season extends z.infer<typeof Season> {}

export const Tv = z.object({
	id: z.int().positive(),
	name: z.string(),
	overview: z.string(),
	first_air_date: z.coerce.date(),
	adult: z.boolean(),
	poster_path: z.string().nullish(),
	backdrop_path: z.string().nullish(),
	seasons: Season.array().optional(),
});

export interface TvInit extends z.input<typeof Tv> {}
export interface Tv extends z.infer<typeof Tv> {}
