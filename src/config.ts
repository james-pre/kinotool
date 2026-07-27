import * as io from 'ioium/node';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import { SourceName } from './common.js';
import { Override } from './media.js';
import { isRoot } from './util.js';

export const Config = z.object({
	apiKeys: z.partialRecord(SourceName, z.string()).default({}),
	cleanPatterns: z
		.array(z.string())
		.default(['^MoviesMod\\.(blue|farm)$', '\\s*-\\s*MoviesMod\\.(blue|farm)\\s*$', '\\s*-\\s*Pahe\\.in\\s*$']),
	media: z.record(z.string(), Override).default({}),
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

export function setCacheDir(path: string) {
	cacheDir = path;
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
