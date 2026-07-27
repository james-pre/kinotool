import * as io from 'ioium/node';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { ResolvedMetadata } from '../common.js';
import { cacheDir, type Config } from '../config.js';
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

const Cache = z.object({
	token: z.string(),
	expires: z.int(),
});

const monthMs = 30 * 24 * 3600_000;

export async function login(apikey: string): Promise<void> {
	if (token) return;

	const cachePath = join(cacheDir, 'tvdb.json');

	try {
		const cache = io.readJSON(cachePath, Cache);
		if (cache.expires > Date.now()) {
			token = cache.token;
			io.debug('tvdb: using cached token');
		} else unlinkSync(cachePath);
	} catch {
		io.debug('tvdb: invalid or outdated cache');
	}

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
	io.writeJSON(cachePath, { token, expires: Date.now() + monthMs - 100 });
}

export async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
	if (!token) throw new Error('Not logged into TVDB');
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
	await login(apikey);

	const params: Record<string, string> = {
		query: identity.title,
		type: identity.type === 'tv' ? 'series' : 'movie',
		limit: '10',
	};
	if (identity.year) params.year = String(identity.year);

	const search = await get<SearchResponse>('/search', params);
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
