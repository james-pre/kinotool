import * as io from 'ioium/node';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';

export const isRoot =
	'process' in globalThis &&
	(globalThis.process.geteuid?.() === 0 ||
		globalThis.process.getegid?.() === 0 ||
		globalThis.process.getuid?.() === 0 ||
		globalThis.process.getgid?.() === 0);

export const Config = z.object({
	tmdbApiKey: z.string().nullish(),
	cleanPatterns: z
		.array(z.string())
		.default(['^MoviesMod\\.(blue|farm)$', '\\s*-\\s*MoviesMod\\.(blue|farm)\\s*$', '\\s*-\\s*Pahe\\.in\\s*$']),
	/** Percent through the media file to grab the local thumbnail frame from. */
	thumbnailPercent: z.number().min(0).max(100).default(35),
	/** Fallback seek (seconds) for the local thumbnail when duration is unknown. */
	thumbnailSeconds: z.number().min(0).default(120),
});
export interface Config extends z.infer<typeof Config> {}

export const defaultConfigPath = join(
	isRoot ? '/etc' : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
	'kinotool.json'
);

export let cacheDir = join(isRoot ? '/var/cache' : process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kinotool');
mkdirSync(cacheDir, { recursive: true });

export function setCacheDir(path: string) {
	cacheDir = path;
	mkdirSync(cacheDir, { recursive: true });
}

export function loadConfig(path: string): Config {
	try {
		return io.readJSON(path, Config);
	} catch (err: any) {
		if (err?.code !== 'ENOENT' && !String(err).includes('ENOENT')) throw err;
		return Config.parse({});
	}
}

export function saveConfig(path: string, config: Partial<Config>): void {
	mkdirSync(dirname(path), { recursive: true });
	io.writeJSON(path, config);
}
