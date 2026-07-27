import type { ResolvedMetadata } from '../common.js';
import type { Config } from '../config.js';
import type * as media from '../media.js';
import { normalizeTitle } from '../util.js';

/** A single movie or TV result from TMDb's search or detail endpoints. */
export interface Result {
	id: number;
	/** Present on movie results. */
	title?: string;
	original_title?: string;
	release_date?: string;
	media_type: 'movie' | 'tv';
	/** Present on TV results. */
	name?: string;
	original_name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	backdrop_path?: string | null;
	overview?: string;
	popularity?: number;
	vote_average?: number;
	vote_count?: number;
	/** Only on TV detail responses, used to cross-reference TVDB/fanart. */
	external_ids?: ExternalIds;
}

export interface CollectionReference {
	id: number;
	name: string;
	poster_path: string;
	backdrop_path: string;
}

export interface GenreRef {
	id: number;
	name: string;
}

export interface Movie {
	adult: boolean;
	backdrop_path: string;
	belongs_to_collection?: CollectionReference;
	genres: GenreRef[];
	homepage?: string;
	id: number;
	imdb_id?: string;
	poster_path: string;
	release_date: string;
	runtime: number;
	title: string;
}

export interface ExternalIds {
	imdb_id?: string | null;
	tvdb_id?: number | null;
	wikidata_id?: string | null;
}

export interface SearchResponse {
	page: number;
	results: Result[];
	total_pages: number;
	total_results: number;
}

let token: string | undefined;

export function setToken(value: string | undefined) {
	token = value;
}

export async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
	const url = new URL(`https://api.themoviedb.org${path}`);
	for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
	return fetchAPI<T>(url);
}

async function fetchAPI<T>(url: URL): Promise<T> {
	if (!token) throw new Error('missing TMDb token');
	const res = await fetch(url, {
		headers: {
			Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
			Accept: 'application/json',
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`TMDb HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	return res.json() as Promise<T>;
}

function toMetadata(identity: media.Identity, media: Result): ResolvedMetadata {
	const title = media.title || media.name || media.original_title || media.original_name || identity.title;
	const releaseDate = media.release_date || media.first_air_date || '';
	const year = releaseDate ? Number(releaseDate.slice(0, 4)) : identity.year;
	const posterUrl = media.poster_path ? `https://image.tmdb.org/t/p/w500${media.poster_path}` : undefined;
	return { title, year, posterUrl, source: 'tmdb' };
}

/** Resolve the TMDb id for an identity, honoring an explicit override first. */
export async function resolveId(identity: media.Identity): Promise<number | null> {
	if (identity.override?.tmdbId) return identity.override.tmdbId;
	const result = await search(identity);
	return result?.id ?? null;
}

async function search(identity: media.Identity): Promise<Result | null> {
	const params: Record<string, string> = {
		query: identity.title,
		include_adult: 'false',
		language: 'en-US',
		page: '1',
	};
	if (identity.year) params[identity.type === 'movie' ? 'year' : 'first_air_date_year'] = String(identity.year);
	const search = await get<SearchResponse>('/3/search/multi', params);
	const results = Array.isArray(search.results) ? search.results : [];

	const normQuery = normalizeTitle(identity.title);

	let topScore = 0,
		topResult: Result | null = null;

	for (const result of results) {
		const title = result.title || result.name || result.original_title || result.original_name || '';
		const releaseDate = result.release_date || result.first_air_date || '';
		const year = releaseDate ? Number(releaseDate.slice(0, 4)) : undefined;

		let score = 0;
		if (normalizeTitle(title) === normQuery) score += 100;
		if (identity.year && year === identity.year) score += 50;
		if (result.poster_path) score += 20;
		score += Math.min(result.popularity ?? 0, 50);

		if (score > topScore) {
			topScore = score;
			topResult = result;
		}
	}

	return topResult;
}

export async function resolve(identity: media.Identity, config: Config): Promise<ResolvedMetadata | null> {
	const token = config.apiKeys?.tmdb;
	if (!token) throw new Error('missing TMDb token');

	if (identity.override?.tmdbId) {
		const media = await get<Result>(`/3/${identity.type}/${identity.override.tmdbId}`);
		return toMetadata(identity, media);
	}

	const best = await search(identity);
	if (!best) return null;
	return toMetadata(identity, best);
}

export const name = 'tmdb';
export const needsKey = true;
