import { Command } from 'commander';
import * as io from 'ioium/node';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringbool } from 'zod';
import $pkg from '../package.json' with { type: 'json' };
import { defaultConfigPath, loadConfig, saveConfig, type Config } from './config.js';
import { extractFrame } from './local.js';
import * as media from './media.js';
import * as mkv from './mkv.js';
import { renameFile } from './name.js';
import { writePosterFromURL } from './poster.js';
import { api, Episode, Movie, resolveTMDB, setTmdbToken } from './tmdb.js';

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

let config: Config;

const cli = new Command('kinotool')
	.version($pkg.version)
	.description($pkg.description)
	.argument('<files...>', 'Media files to process')
	.option('-C, --config <path>', 'Path to the configuration file', defaultConfigPath)
	.option('-L, --local', 'Do not use TMDB for fetching metadata')
	.option('--replace-thumbnail', 'Replace embedded cover art from a source')
	.option('--replace-title', 'Replace the container title from a metadata source')
	.option('-c, --clean', 'Clean subtitle/audio/title names with configured regex patterns')
	.option('-N, --replace-filename', 'Rename the file: strip quality/source tags and join words with underscores')
	.option('-a, --audio-default', 'Set default audio track to AAC, ignoring commentary/descriptive tracks')
	.option('-r, --recursive', 'Recurse into directories, processing every media file found')
	.option('--debug', 'Enable debug output')
	.showHelpAfterError()
	.action(async function main(files: string[], options) {
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
			const identity = media.fromPath(absPath);

			if (isInfoOnly) {
				console.log(media.formatIdentity(identity));
				continue;
			}

			const metadata =
				(!options.local &&
					(options.replaceThumbnail || options.replaceTitle) &&
					(await resolveTMDB(identity))) ||
				null;

			if (options.clean) {
				const patterns = (config.cleanPatterns || []).map(p => new RegExp(p, 'g'));
				mkv.cleanTrackNames(absPath, info, patterns);
				mkv.cleanContainerTitle(absPath, info, patterns);
			}

			if (options.audioDefault) {
				mkv.setAacDefaultAudio(absPath, info);
			}

			if (options.replaceTitle) {
				const overallTitle =
					metadata?.media_type == 'movie' ? metadata.title : metadata?.name || identity.title;
				const title = identity.isTV
					? `${overallTitle} - S${String(identity.season).padStart(2, '0')}E${String(identity.episode).padStart(2, '0')}`
					: overallTitle;
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
						coverPath = extractFrame(
							identity.inputPath,
							identity,
							config.thumbnailSeconds,
							config.thumbnailPercent
						);
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

cli.on('option:config', value => {
	config = loadConfig(value);
	if (config.tmdbApiKey) setTmdbToken(config.tmdbApiKey);
});

cli.command('fix-movie')
	.description('Set metadata for a movie from TMDB')
	.argument('<path>', 'Path to the movie file')
	.option('-t, --title <title>', 'Title of the movie')
	.option('-y, --year <year>', 'Year of the movie', value => parseInt(value, 10))
	.option('--id <id>', 'ID of the movie', value => parseInt(value, 10))
	.action(async function main(path: string, options) {
		if (!options.id && !options.title) throw 'Either --id or --title must be provided';

		const result = options.id
			? await api.movies.details(options.id)
			: await api.search.movies({ query: options.title!, year: options.year }).then(r => r.results[0]);

		if (!result) throw 'Could not find a matching movie';

		await mkv.setFromMovie(path, Movie.parse(result));
	});

cli.command('fix-episode')
	.description('Set metadata for an episode from TMDB')
	.argument('<path>', 'Path to the episode file')
	.option('-n, --name <name>', 'Name of the episode')
	.option('--id <id>', 'ID of the TV show', value => parseInt(value, 10))
	.option('-y, --year <year>', 'Year of the episode', value => parseInt(value, 10))
	.requiredOption('-s, --season <season>', 'Season number', value => parseInt(value, 10))
	.requiredOption('-e, --episode <episode>', 'Episode number', value => parseInt(value, 10))
	.action(async function main(path: string, options) {
		if (!options.id && !options.name) throw 'Either --id or --name must be provided';

		const id =
			options.id ||
			(await api.search.tvShows({ query: options.name!, year: options.year }).then(r => r.results[0].id));

		if (!id) throw 'Could not find a matching TV show';

		const episode = await api.tvEpisode.details({
			tvShowID: id,
			seasonNumber: options.season,
			episodeNumber: options.episode,
		});

		await mkv.setFromEpisode(path, Episode.parse(episode));
	});

export default cli;
