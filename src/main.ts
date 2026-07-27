#!/usr/bin/env node

import cli from './cli.js';
import { exit } from 'ioium/node';

try {
	await cli.parseAsync();
} catch (err) {
	exit(err, 1);
}
