#!/usr/bin/env node

import { program } from '@commander-js/extra-typings';
import * as io from 'ioium/node';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import $pkg from '../package.json' with { type: 'json' };
import type { ResolvedMetadata, Source, SourceName } from './common.js';
import { loadConfig, saveConfig, type Config } from './config.js';
import * as mkv from './formats/mkv.js';
import * as media from './media.js';
import { renameFile } from './name.js';
import * as sources from './sources/index.js';
import { isRoot, normalizeSources, resolveMetadata } from './util.js';

async function prepareSources(names: SourceName[], config: Config): Promise<Source[]> {
	const _sources = names.map(src => sources[src]);
	using rl = io.getReadline();
	for (const source of _sources) {
		if (!source.needsKey || config.apiKeys[source.name]) continue;
		const key = await rl.question(`Enter API key for ${source.name}: `);
		if (!key.trim()) throw new Error(`API key is required for ${source.name}`);
		config.apiKeys[source.name] = key.trim();
	}
	return _sources;
}

/** Expand input paths into .mkv files, descending into directories when recursive. */
function* collectFiles(inputs: Iterable<string>, recursive: boolean): Generator<string> {
	for (const input of inputs) {
		const absPath = resolve(input);
		let stats;
		try {
			stats = statSync(absPath);
		} catch {
			io.error(`skip: ${input}: not found`);
			continue;
		}

		if (stats.isFile()) {
			if (/\.mkv$/i.test(absPath)) yield absPath;
			else io.error(`skip: ${input}: not an MKV file`);
		} else if (stats.isDirectory()) {
			if (!recursive) {
				io.error(`skip: ${input}: is a directory (use -r to recurse)`);
				continue;
			}
			const entries = readdirSync(absPath).map(name => join(absPath, name));
			yield* collectFiles(entries, recursive);
		}
	}
}

const defaultConfigPath = join(
	isRoot ? '/etc' : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
	'kinotool.json'
);

program
	.name('kinotool')
	.version($pkg.version)
	.description($pkg.description)
	.argument('<files...>', 'Media files to process')
	.option('-C, --config <path>', 'Path to the configuration file', defaultConfigPath)
	.option(
		'-S, --source <name...>',
		'Source(s) in fallback order: local, tmdb, tvdb, fanart',
		(value, previous: string[] = []) => [...previous, value]
	)
	.option('-t, --replace-thumbnail', 'Replace embedded cover art from a source')
	.option('-n, --replace-title', 'Replace the container title from a metadata source')
	.option('-c, --clean', 'Clean subtitle/audio/title names with configured regex patterns')
	.option('-N, --replace-filename', 'Rename the file: strip quality/source tags and join words with underscores')
	.option('-a, --audio-default', 'Set default audio track to AAC, ignoring commentary/descriptive tracks')
	.option('-r, --recursive', 'Recurse into directories, processing every media file found')
	.option('--debug', 'Verbose debug output')
	.showHelpAfterError()
	.action(async function main(files: string[], options) {
		if (options.debug) io._setDebugOutput(true);

		if (
			!options.replaceThumbnail &&
			!options.replaceTitle &&
			!options.clean &&
			!options.audioDefault &&
			!options.replaceFilename
		) {
			throw new Error('Nothing to do. Use -t, -n, -c, -a, and/or -N. The machines require verbs.');
		}

		const config = loadConfig(options.config);
		const requestedSources = normalizeSources(options.source);
		const activeSources =
			options.replaceThumbnail || options.replaceTitle ? await prepareSources(requestedSources, config) : [];

		const absFiles = Array.from(collectFiles(files, !!options.recursive));
		if (!absFiles.length) throw new Error('No MKV files to process.');

		for (const absPath of absFiles) {
			if (absFiles.length > 1) io.log(`\n=== ${absPath} ===`);
			const info = mkv.getInfo(absPath);
			const identity = media.identify(absPath, config);

			let metadata: ResolvedMetadata | null = null;
			if (options.replaceThumbnail || options.replaceTitle) {
				metadata = await resolveMetadata(identity, activeSources, config);
				if (!metadata) {
					io.error(`metadata: no match for ${identity.title}`);
				} else {
					io.log(
						`metadata: ${metadata.title}${metadata.year ? ` (${metadata.year})` : ''} via ${metadata.source}`
					);
				}
			}

			if (options.clean) {
				mkv.cleanTrackNames(absPath, info, config);
				mkv.cleanContainerTitle(absPath, info, config);
			}

			if (options.audioDefault) {
				mkv.setAacDefaultAudio(absPath, info);
			}

			if (options.replaceTitle && metadata) {
				const title = identity.override?.mkvTitle || metadata.title || identity.mkvTitle;
				mkv.setContainerTitle(absPath, title);
			}

			if (options.replaceThumbnail && metadata) {
				const coverPath = await mkv.getPoster(identity, metadata);
				if (coverPath) {
					mkv.replaceCover(absPath, coverPath);
				} else {
					io.error('thumbnail: no poster available');
				}
			}

			// Rename last, since it changes the path every other step operates on.
			if (options.replaceFilename) renameFile(absPath);
		}

		saveConfig(options.config, config);
	});

try {
	await program.parseAsync();
} catch (err) {
	io.exit(err, 1);
}
