/**
 * Entry point of the process that owns the libtorrent session.
 * It is started by `Client` and does whatever it is asked over IPC.
 */
import { errorText } from 'ioium';
import { createRequire } from 'node:module';
import type { Alert, Message, Methods, Request, Settings, ThreadInit } from './shared.js';

interface NativeSession extends Methods {
	postUpdates(): void;
	alerts(): Alert[];
}

interface Native {
	Session: new (settings: Settings, onAlerts: () => void) => NativeSession;
}

// @todo Switch to an ESM addon import once `--experimental-addon-modules` is unflagged
const native: Native = createRequire(import.meta.url)('./native.node');

if (!process.send) throw new Error('The torrent thread has to be started with an IPC channel');

const init = JSON.parse(process.argv[2]) as ThreadInit;

function send(message: Message, callback?: () => void): void {
	process.send!(message, undefined, undefined, callback);
}

const session = new native.Session(init.settings, () => {
	const alerts = session.alerts();
	if (alerts.length) send({ alerts });
});

const updates = setInterval(() => session.postUpdates(), init.statusInterval);

function close(): void {
	clearInterval(updates);
	session.close();
}

process.on('message', (request: Request) => {
	let message: Message;

	try {
		const method = session[request.method].bind(session) as (...args: unknown[]) => unknown;
		const result = method(...request.args);
		message = { call: request.call, result: result ?? null };
	} catch (error) {
		message = { call: request.call, error: errorText(error) };
	}

	if (request.method != 'close') {
		send(message);
		return;
	}

	send(message, () => process.disconnect!());
});

// Also covers the parent going away without closing the session
process.on('disconnect', close);
