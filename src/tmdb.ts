import { TMDB } from 'tmdb-ts';
import type * as tmdb from 'tmdb-ts';
import type { Config } from './config.js';
import type * as media from './media.js';
import { normalizeTitle } from './util.js';

export let api: TMDB;

export async function resolveTMDB(
	identity: media.Identity,
	config: Config
): Promise<tmdb.MovieWithMediaType | tmdb.TVWithMediaType | null> {
	const token = config.tmdbApiKey;
	if (!token) throw new Error('missing TMDb token');

	api ||= new TMDB(token);

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
