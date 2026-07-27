import { Command } from 'commander';
import * as io from 'ioium/node';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringbool } from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';
import { extractFrame } from './local.js';
import * as media from './media.js';
import * as mkv from './mkv.js';
import { renameFile } from './name.js';
import { writePosterFromURL } from './poster.js';
import { resolveTMDB } from './tmdb.js';

const debug = stringbool().safeParse(process.env.DEBUG).data || process.argv.includes('--debug');
if (debug) io._setDebugOutput(true);

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

const cli = new Command('kinotool')
	.version($pkg.version)
	.description($pkg.description)
	.argument('<files...>', 'Media files to process')
	.option('-C, --config <path>', 'Path to the configuration file', defaultConfigPath)
	.option('-L, --local', 'Do not use TMDB for fetching metadata')
	.option('-t, --replace-thumbnail', 'Replace embedded cover art from a source')
	.option('-n, --replace-title', 'Replace the container title from a metadata source')
	.option('-c, --clean', 'Clean subtitle/audio/title names with configured regex patterns')
	.option('-N, --replace-filename', 'Rename the file: strip quality/source tags and join words with underscores')
	.option('-a, --audio-default', 'Set default audio track to AAC, ignoring commentary/descriptive tracks')
	.option('-r, --recursive', 'Recurse into directories, processing every media file found')
	.option('--debug', 'Enable debug output')
	.showHelpAfterError()
	.action(async function main(files: string[], options) {
		const config = loadConfig(options.config);

		const absFiles = Array.from(collectFiles(files, !!options.recursive));
		if (!absFiles.length) throw new Error('No files specified.');

		const isInfoOnly =
			!options.replaceThumbnail &&
			!options.replaceTitle &&
			!options.clean &&
			!options.audioDefault &&
			!options.replaceFilename;

		for (const absPath of absFiles) {
			if (absFiles.length > 1) io.log(`\n=== ${absPath} ===`);
			const info = mkv.getInfo(absPath);
			const identity = media.identify(absPath);

			if (isInfoOnly) {
				console.log(media.formatIdentity(identity));
				continue;
			}

			const metadata =
				(!options.local &&
					(options.replaceThumbnail || options.replaceTitle) &&
					(await resolveTMDB(identity, config))) ||
				null;

			if (options.clean) {
				mkv.cleanTrackNames(absPath, info, config);
				mkv.cleanContainerTitle(absPath, info, config);
			}

			if (options.audioDefault) {
				mkv.setAacDefaultAudio(absPath, info);
			}

			if (options.replaceTitle) {
				const overallTitle =
					metadata?.media_type == 'movie' ? metadata.title : metadata?.name || identity.title;
				const title =
					identity.type == 'movie'
						? overallTitle
						: `${overallTitle} - S${String(identity.season).padStart(2, '0')}E${String(identity.episode).padStart(2, '0')}`;
				mkv.setContainerTitle(absPath, title);
			}

			if (options.replaceThumbnail) {
				let coverPath: string | undefined;

				if (metadata) {
					coverPath = await writePosterFromURL(
						identity,
						`https://image.tmdb.org/t/p/w500${metadata.poster_path}`
					);
				} else {
					try {
						coverPath = extractFrame(identity.inputPath, identity, config);
					} catch (err: any) {
						io.warn(`local: frame extraction failed: ${err.message}`);
					}
				}

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

export default cli;
