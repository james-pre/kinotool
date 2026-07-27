import { resolve } from 'node:path';
import type { ResolvedMetadata, Source, SourceName } from './common.js';
import { type Config } from './config.js';
import type * as media from './media.js';

const SOURCE_NAMES: SourceName[] = ['local', 'tmdb', 'tvdb', 'fanart'];

export function normalizeSources(input: string[] | string | undefined): SourceName[] {
	const raw = Array.isArray(input) ? input : input ? [input] : [];
	const sources = raw.length ? raw : ['local'];
	return sources.map(s => {
		if (!SOURCE_NAMES.includes(s as SourceName)) throw new Error(`Unknown source: ${s}`);
		return s as SourceName;
	});
}

export function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Apply configured cleanup regexes to a string, collapsing leftover whitespace. */
export function applyCleanPatterns(value: string, patterns: RegExp[]): string {
	let out = value;
	for (const pattern of patterns) out = out.replace(pattern, '');
	return out.replace(/\s+/g, ' ').trim();
}

export async function resolveMetadata(
	identity: media.Identity,
	sources: Source[],
	config: Config
): Promise<ResolvedMetadata | null> {
	if (identity.override?.poster && identity.override?.title) {
		return {
			title: identity.override.title,
			year: identity.override.year,
			posterPath: resolve(identity.override.poster),
			source: 'manual',
		};
	}

	for (const source of sources) {
		try {
			const result = await source.resolve(identity, config);
			if (result) return result;
		} catch (err: any) {
			console.error(`${source.name}: ${err.message}`);
		}
	}
	return null;
}

export const isRoot =
	process.geteuid?.() === 0 || process.getegid?.() === 0 || process.getuid?.() === 0 || process.getgid?.() === 0;
