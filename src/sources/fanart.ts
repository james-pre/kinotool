import type { ResolvedMetadata } from '../common.js';
import type { Config } from '../config.js';
import type * as media from '../media.js';
import * as tmdb from './tmdb.js';

export interface Image {
	id: string;
	url: string;
	lang?: string;
	likes?: string;
}

export interface MovieResponse {
	movieposter?: Image[];
	moviethumb?: Image[];
}

export interface TvResponse {
	tvposter?: Image[];
	tvthumb?: Image[];
}

/** Highest-liked image, preferring English-language art. */
export function pickImage(images: Image[] | undefined): string | undefined {
	if (!images?.length) return undefined;
	const sorted = [...images].sort((a, b) => {
		const langScore = (img: Image) => (img.lang === 'en' ? 1 : img.lang === '' ? 0.5 : 0);
		const score = langScore(b) - langScore(a);
		if (score !== 0) return score;
		return Number(b.likes ?? 0) - Number(a.likes ?? 0);
	});
	return sorted[0].url;
}

export async function get<T>(apiKey: string, path: string): Promise<T | null> {
	const url = new URL(`https://webservice.fanart.tv/v3${path}`);
	url.searchParams.set('api_key', apiKey);
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (res.status === 404) return null;
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`fanart.tv HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

export async function resolve(identity: media.Identity, config: Config): Promise<ResolvedMetadata | null> {
	const apiKey = config.apiKeys?.fanart;
	if (!apiKey) throw new Error('missing fanart.tv API key');

	if (identity.type === 'tv') {
		let tvdbId: number | undefined;

		// fanart.tv has no search; it keys off TMDb (movies) or TVDB (TV) ids.
		// We lean on the TMDb token to resolve those ids when not overridden.
		if (config.apiKeys?.tmdb) {
			const tmdbId = await tmdb.resolveId(identity);
			if (tmdbId) {
				const ids = await tmdb.api.tvShows.externalIds(tmdbId);
				tvdbId = ids.tvdb_id ?? undefined;
			}
		}
		if (!tvdbId) throw new Error('fanart.tv TV lookup needs a TVDB id (set a TMDb key or tmdbId override)');

		const data = await get<TvResponse>(apiKey, `/tv/${tvdbId}`);
		const posterUrl = pickImage(data?.tvposter) || pickImage(data?.tvthumb);
		if (!posterUrl) return null;
		return { title: identity.title, year: identity.year, posterUrl, source: 'fanart' };
	}

	let tmdbId = identity.override?.tmdbId;
	if (!tmdbId && config.apiKeys?.tmdb) tmdbId = (await tmdb.resolveId(identity)) ?? undefined;
	if (!tmdbId) throw new Error('fanart.tv movie lookup needs a TMDb id (set a TMDb key or tmdbId override)');

	const data = await get<MovieResponse>(apiKey, `/movies/${tmdbId}`);
	const posterUrl = pickImage(data?.movieposter) || pickImage(data?.moviethumb);
	if (!posterUrl) return null;
	return { title: identity.title, year: identity.year, posterUrl, source: 'fanart' };
}

export const name = 'fanart';

export const needsKey = true;
