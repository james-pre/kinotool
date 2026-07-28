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
