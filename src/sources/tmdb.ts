import { TMDB } from 'tmdb-ts';
import type * as tmdb from 'tmdb-ts';
import type { ResolvedMetadata } from '../common.js';
import type { Config } from '../config.js';
import type * as media from '../media.js';
import { normalizeTitle } from '../util.js';

export let api: TMDB;

function movieToMetadata(identity: media.Identity, media: tmdb.Movie | tmdb.MovieDetails): ResolvedMetadata {
	const title = media.title || media.original_title || identity.title;
	const year = media.release_date ? Number(media.release_date.slice(0, 4)) : identity.year;
	const posterUrl = media.poster_path ? `https://image.tmdb.org/t/p/w500${media.poster_path}` : undefined;
	return { title, year, posterUrl, source: 'tmdb' };
}

function tvToMetadata(identity: media.Identity, media: tmdb.TV | tmdb.TvShowDetails): ResolvedMetadata {
	const title = media.name || media.original_name || identity.title;
	const year = media.first_air_date ? Number(media.first_air_date.slice(0, 4)) : identity.year;
	const posterUrl = media.poster_path ? `https://image.tmdb.org/t/p/w500${media.poster_path}` : undefined;
	return { title, year, posterUrl, source: 'tmdb' };
}

/** Resolve the TMDb id for an identity, honoring an explicit override first. */
export async function resolveId(identity: media.Identity): Promise<number | null> {
	if (identity.override?.tmdbId) return identity.override.tmdbId;
	const result = await search(identity);
	return result?.id ?? null;
}

async function search(identity: media.Identity): Promise<tmdb.MovieWithMediaType | tmdb.TVWithMediaType | null> {
	const normQuery = normalizeTitle(identity.title);

	const { results } = await api.search.multi({
		query: normQuery,
		language: 'en-US',
		page: 1,
		include_adult: true,
	});

	let topScore = 0,
		topResult: tmdb.MovieWithMediaType | tmdb.TVWithMediaType | null = null;

	for (const result of results) {
		if (result.media_type == 'person') continue;

		const title =
			result.media_type == 'tv' ? result.name || result.original_name : result.title || result.original_title;
		const releaseDate = result.media_type == 'tv' ? result.first_air_date : result.release_date;
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

	api ||= new TMDB(token);

	if (identity.override?.tmdbId) {
		if (identity.type == 'tv') {
			const media = await api.tvShows.details(identity.override.tmdbId);
			return tvToMetadata(identity, media);
		} else {
			const media = await api.movies.details(identity.override.tmdbId);
			return movieToMetadata(identity, media);
		}
	}

	const best = await search(identity);
	if (!best) return null;

	return best.media_type == 'tv' ? tvToMetadata(identity, best) : movieToMetadata(identity, best);
}

export const name = 'tmdb';
export const needsKey = true;
