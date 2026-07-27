import * as io from 'ioium/node';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from './config.js';
import type * as media from './media.js';

function safeFileName(value: string): string {
	return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

export async function writePosterFromURL(identity: media.Identity, url: string): Promise<string> {
	const cacheName = `${safeFileName(identity.title)}${identity.year ? `-${identity.year}` : ''}.poster.jpg`;
	const outPath = join(cacheDir, cacheName);

	try {
		fs.accessSync(outPath, fs.constants.R_OK);
		io.debug(`thumbnail: cached ${outPath}`);
		return outPath;
	} catch {
		// download below
	}

	io.debug(`thumbnail: download ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`poster download failed: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	fs.writeFileSync(outPath, bytes);
	return outPath;
}
