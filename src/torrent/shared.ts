import * as z from 'zod';

/**
 * libtorrent settings by name.
 * @see https://www.libtorrent.org/reference-Settings.html
 */
export const Settings = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type Settings = z.infer<typeof Settings>;

export type State =
	| 'checking_files'
	| 'downloading_metadata'
	| 'downloading'
	| 'finished'
	| 'seeding'
	| 'checking_resume_data'
	| 'unknown';

export interface Status {
	id: string;
	name: string;
	state: State;
	/** The directory files are saved relative to */
	directory: string;
	/** Progress of the selected files, from 0 to 1 */
	progress: number;
	/** In bytes per second */
	downloadRate: number;
	/** In bytes per second */
	uploadRate: number;
	/** Size of the selected files, in bytes */
	wanted: number;
	/** How much of the selected files has been downloaded, in bytes */
	done: number;
	/** Uploaded across every session, in bytes */
	uploaded: number;
	peers: number;
	seeds: number;
	paused: boolean;
	error: string | null;
}

export interface File {
	index: number;
	/** Relative to the torrent's directory, unless it has been moved somewhere absolute */
	path: string;
	/** In bytes */
	size: number;
	/** Whether the file is being downloaded */
	selected: boolean;
}

export interface AddParams {
	/** A magnet link, or the contents of a .torrent file */
	source?: string | Uint8Array;
	/** Resume data from a previous session, used instead of `source` */
	resume?: Uint8Array;
	directory?: string;
	paused?: boolean;
}

export type Alert =
	| { type: 'status'; statuses: Status[] }
	| { type: 'metadata' | 'finished' | 'removed'; id: string }
	| { type: 'error' | 'resume_data_failed'; id: string; message: string }
	| { type: 'resume_data'; id: string; data: Uint8Array<ArrayBuffer> }
	| { type: 'renamed'; id: string; index: number; name: string }
	| { type: 'rename_failed'; id: string; index: number; message: string }
	| { type: 'warning'; id?: string; message: string };

/** What the thread can be asked to do */
export interface Methods {
	add(params: AddParams): string;
	files(id: string): File[] | null;
	/** Download only these files */
	select(id: string, indices: number[]): void;
	rename(id: string, index: number, name: string): void;
	pause(id: string): void;
	resume(id: string): void;
	saveResumeData(id: string): void;
	remove(id: string, deleteFiles: boolean): void;
	status(id: string): Status;
	applySettings(settings: Settings): void;
	close(): void;
}

export type Method = keyof Methods;

export type Request = {
	[M in Method]: { call: number; method: M; args: Parameters<Methods[M]> };
}[Method];

/** What the thread sends back */
export type Message = { call: number; result: unknown } | { call: number; error: string } | { alerts: Alert[] };

export interface ThreadInit {
	settings: Settings;
	/** How often status updates are posted, in milliseconds */
	statusInterval: number;
}
