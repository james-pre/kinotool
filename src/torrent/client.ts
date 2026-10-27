import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { Alert, Message, Method, Methods, Settings, ThreadInit, File, Status } from './shared.js';

export const videoExtensions = ['.mkv', '.mp4', '.m4v', '.webm', '.mov', '.avi', '.wmv', '.mpg', '.mpeg', '.ts'];

export interface DownloadOptions {
	/** A magnet link, or the contents of a .torrent file */
	source?: string | Uint8Array;
	/** Resume data from a previous session, used instead of `source` */
	resume?: Uint8Array;
	/** Where files are written. Required unless resuming. */
	directory?: string;
	paused?: boolean;
	/** Extensions of the files to download, including the dot. Defaults to {@link videoExtensions}. */
	extensions?: string[];
	/**
	 * Pick which files to download when more than one has a matching extension.
	 * Picking none removes the torrent. By default, every matching file is downloaded.
	 */
	select?(files: File[]): number[] | Promise<number[]>;
}

export interface DownloadEvents {
	/** Files were picked and are being downloaded */
	selected: [files: File[]];
	status: [status: Status];
	/** Every selected file is complete, with absolute paths. Can happen again, e.g. after resuming. */
	finished: [files: File[]];
	resume_data: [data: Uint8Array<ArrayBuffer>];
	failed: [error: Error];
	removed: [];
}

export class Download extends EventEmitter<DownloadEvents> {
	status?: Status;

	/** Whether the files to download have been picked */
	isSelected: boolean = false;

	protected selection?: Promise<void>;
	protected readonly renames = new Map<number, PromiseWithResolvers<void>>();
	protected savingResumeData?: PromiseWithResolvers<Uint8Array<ArrayBuffer>>;
	protected removing?: PromiseWithResolvers<void>;

	constructor(
		protected readonly client: Client,
		readonly id: string,
		protected readonly options: DownloadOptions
	) {
		super();
	}

	protected fail(error: unknown): void {
		this.emit('failed', error instanceof Error ? error : new Error(String(error)));
	}

	/**
	 * Select files once the torrent's metadata is available.
	 * @internal
	 */
	start(): Promise<void> {
		this.selection ??= this.select()
			.catch(error => this.fail(error))
			.finally(() => {
				// Without metadata there was nothing to select yet
				if (!this.isSelected) this.selection = undefined;
			});

		return this.selection;
	}

	protected async select(): Promise<void> {
		const files = await this.files();
		if (!files) return;

		// Resumed with files already picked
		if (files.some(file => file.selected)) {
			this.isSelected = true;
			return;
		}

		const extensions = this.options.extensions ?? videoExtensions;
		const matching = files.filter(file => extensions.includes(extname(file.path).toLowerCase()));
		if (!matching.length) throw new Error('The torrent does not have any media files');

		const indices =
			matching.length > 1 && this.options.select
				? await this.options.select(matching)
				: matching.map(file => file.index);

		if (!indices.length) {
			await this.remove({ deleteFiles: true });
			return;
		}

		const selected = matching.filter(file => indices.includes(file.index));
		if (selected.length != new Set(indices).size) throw new Error('Only media files can be selected');

		await this.client.call('select', this.id, indices);

		// A lone file goes straight in the directory rather than in a folder named after the torrent
		const [file] = selected;
		if (selected.length == 1 && file.path != basename(file.path)) {
			await this.rename(file.index, basename(file.path));
			file.path = basename(file.path);
		}

		this.isSelected = true;
		for (const file of selected) file.selected = true;
		this.emit('selected', selected);

		await this.saveResumeData();
	}

	protected async finish(): Promise<void> {
		const files = await this.files();
		const { directory } = await this.client.call('status', this.id);

		const selected = (files ?? [])
			.filter(file => file.selected)
			.map(file => ({ ...file, path: isAbsolute(file.path) ? file.path : join(directory, file.path) }));

		this.emit('finished', selected);

		await this.saveResumeData();
	}

	/** @internal */
	handle(alert: Alert): void {
		switch (alert.type) {
			case 'metadata':
				void this.start();
				break;
			case 'finished':
				if (this.isSelected) this.finish().catch(error => this.fail(error));
				break;
			case 'error':
				this.fail(alert.message);
				break;
			case 'resume_data':
				this.savingResumeData?.resolve(alert.data);
				this.savingResumeData = undefined;
				this.emit('resume_data', alert.data);
				break;
			case 'resume_data_failed':
				this.savingResumeData?.reject(new Error(alert.message));
				this.savingResumeData = undefined;
				break;
			case 'renamed':
				this.renames.get(alert.index)?.resolve();
				this.renames.delete(alert.index);
				break;
			case 'rename_failed':
				this.renames.get(alert.index)?.reject(new Error(alert.message));
				this.renames.delete(alert.index);
				break;
			case 'removed':
				this.removing?.resolve();
				this.emit('removed');
				break;
		}
	}

	/** @internal */
	update(status: Status): void {
		this.status = status;
		this.emit('status', status);
	}

	/** Null until the torrent's metadata is available */
	files(): Promise<File[] | null> {
		return this.client.call('files', this.id);
	}

	protected async rename(index: number, name: string): Promise<void> {
		const renamed = Promise.withResolvers<void>();
		this.renames.set(index, renamed);

		try {
			await this.client.call('rename', this.id, index, name);
		} catch (error) {
			this.renames.delete(index);
			throw error;
		}

		await renamed.promise;
	}

	/**
	 * Move files to absolute paths, e.g. into a library. Seeding continues from the new paths.
	 * @param paths Destination paths by file index
	 */
	async move(paths: Map<number, string>): Promise<void> {
		for (const [index, path] of paths) {
			if (!isAbsolute(path)) throw new Error('Files can only be moved to absolute paths');
			mkdirSync(dirname(path), { recursive: true });
			await this.rename(index, path);
		}

		await this.saveResumeData();
	}

	pause(): Promise<void> {
		return this.client.call('pause', this.id);
	}

	resume(): Promise<void> {
		return this.client.call('resume', this.id);
	}

	/** Also emitted as `resume_data` */
	async saveResumeData(): Promise<Uint8Array<ArrayBuffer>> {
		if (this.savingResumeData) return this.savingResumeData.promise;

		this.savingResumeData = Promise.withResolvers();
		const { promise } = this.savingResumeData;
		await this.client.call('saveResumeData', this.id);
		return promise;
	}

	/** Stop the torrent. Files are kept unless `deleteFiles` is set, including ones that were moved. */
	async remove(options: { deleteFiles?: boolean } = {}): Promise<void> {
		if (this.removing) return this.removing.promise;

		this.removing = Promise.withResolvers();
		const { promise } = this.removing;
		await this.client.call('remove', this.id, !!options.deleteFiles);
		return promise;
	}
}

export interface ClientOptions {
	settings?: Settings;
	/** How often status is updated, in milliseconds */
	statusInterval?: number;
}

export interface ClientEvents {
	warning: [message: string, download?: Download];
	exit: [code: number | null, signal: NodeJS.Signals | null];
}

/** Downloads torrents in a separate process, so a crash in libtorrent can't take the caller down with it */
export class Client extends EventEmitter<ClientEvents> {
	protected readonly thread: ChildProcess;
	protected readonly calls = new Map<number, PromiseWithResolvers<any>>();
	protected lastCall = 0;
	protected readonly active = new Map<string, Download>();

	get downloads(): ReadonlyMap<string, Download> {
		return this.active;
	}

	constructor(options: ClientOptions = {}) {
		super();

		const init: ThreadInit = { settings: options.settings ?? {}, statusInterval: options.statusInterval ?? 1000 };

		this.thread = fork(new URL('./thread.js', import.meta.url), [JSON.stringify(init)], {
			serialization: 'advanced',
		});

		this.thread.on('message', (message: Message) => this.receive(message));
		this.thread.on('exit', (code, signal) => this.exited(code, signal));
	}

	/** @internal */
	call<M extends Method>(method: M, ...args: Parameters<Methods[M]>): Promise<ReturnType<Methods[M]>> {
		if (!this.thread.connected) return Promise.reject(new Error('The torrent thread is not running'));

		const call = ++this.lastCall;
		const pending = Promise.withResolvers<ReturnType<Methods[M]>>();
		this.calls.set(call, pending);
		this.thread.send({ call, method, args });
		return pending.promise;
	}

	protected receive(message: Message): void {
		if ('alerts' in message) {
			for (const alert of message.alerts) this.dispatch(alert);
			return;
		}

		const pending = this.calls.get(message.call);
		if (!pending) return;
		this.calls.delete(message.call);

		if ('error' in message) pending.reject(new Error(message.error));
		else pending.resolve(message.result);
	}

	protected dispatch(alert: Alert): void {
		if (alert.type == 'status') {
			for (const status of alert.statuses) this.active.get(status.id)?.update(status);
			return;
		}

		const download = alert.id ? this.active.get(alert.id) : undefined;

		if (alert.type == 'warning') {
			this.emit('warning', alert.message, download);
			return;
		}

		download?.handle(alert);
		if (alert.type == 'removed') this.active.delete(alert.id);
	}

	protected exited(code: number | null, signal: NodeJS.Signals | null): void {
		for (const pending of this.calls.values()) pending.reject(new Error('The torrent thread exited'));
		this.calls.clear();
		this.active.clear();
		this.emit('exit', code, signal);
	}

	/** Resolves once the torrent is added. Files are selected in the background, see {@link DownloadOptions.select}. */
	async add(options: DownloadOptions): Promise<Download> {
		const { source, resume, directory, paused } = options;
		const id = await this.call('add', { source, resume, directory, paused });

		const download = new Download(this, id, options);
		this.active.set(id, download);
		void download.start();

		return download;
	}

	applySettings(settings: Settings): Promise<void> {
		return this.call('applySettings', settings);
	}

	/** Stops every torrent. Save resume data first to continue them later. */
	async close(): Promise<void> {
		if (!this.thread.connected) return;
		await this.call('close');
	}
}
