import type { ResolvedMetadata } from '../common.js';
import type { Config } from '../config.js';
import type * as media from '../media.js';

export interface LoginResponse {
	status: string;
	data: { token: string };
}

export interface SearchResult {
	tvdb_id?: string;
	name?: string;
	year?: string;
	type?: string;
	image_url?: string;
	poster?: string;
	posters?: string[];
	thumbnail?: string;
}

export interface SearchResponse {
	status: string;
	data: SearchResult[];
}

let token: string | undefined;

export async function login(apikey: string): Promise<string> {
	if (token) return token;
	const res = await fetch('https://api4.thetvdb.com/v4/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ apikey }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`TVDB login HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	const json = (await res.json()) as LoginResponse;
	token = json.data.token;
	return token;
}

export async function get<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
	const url = new URL(`https://api4.thetvdb.com/v4${path}`);
	for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`TVDB HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

export async function resolve(identity: media.Identity, config: Config): Promise<ResolvedMetadata | null> {
	const apikey = config.apiKeys?.tvdb;
	if (!apikey) throw new Error('missing TVDB API key');
	const token = await login(apikey);

	const params: Record<string, string> = {
		query: identity.title,
		type: identity.type === 'tv' ? 'series' : 'movie',
		limit: '10',
	};
	if (identity.year) params.year = String(identity.year);

	const search = await get<SearchResponse>(token, '/search', params);
	const results = Array.isArray(search.data) ? search.data : [];
	if (results.length === 0) return null;

	// Results come back ranked; the first with a poster/image wins.
	const best = results.find(r => r.image_url || r.poster || r.posters?.length) ?? results[0];
	const posterUrl = best.image_url || best.poster || best.posters?.[0] || best.thumbnail;
	const year = best.year ? Number(best.year) : identity.year;
	return { title: best.name || identity.title, year, posterUrl, source: 'tvdb' };
}

export const name = 'tvdb';
export const needsKey = true;
