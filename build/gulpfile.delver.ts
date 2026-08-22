/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ansiColors from 'ansi-colors';
import es from 'event-stream';
import fancyLog from 'fancy-log';
import { gulp } from './lib/gulp/facade.ts';
import * as task from './lib/gulp/task.ts';
import { debounce } from './lib/util.ts';
import watcher from './lib/watch/index.ts';

const root = 'delver';
const rootAbs = path.resolve(import.meta.dirname, '..', root);
const src = `${root}/**/*.rs`;
const cargoFiles = [`${root}/Cargo.toml`, `${root}/**/Cargo.toml`];

const binaries = ['provider-file', 'server-analysis', 'delverctl', 'delver-agent-relay', 'delver-mcp'];
const platform = process.platform;
const binExt = platform === 'win32' ? '.exe' : '';

const hasLocalRust = (() => {
	let result: boolean | undefined = undefined;
	return () => {
		if (result !== undefined) {
			return result;
		}

		try {
			const r = cp.spawnSync('cargo', ['--version']);
			result = r.status === 0;
		} catch (e) {
			result = false;
		}

		return result;
	};
})();

const warnIfRustNotInstalled = () => {
	if (!hasLocalRust()) {
		fancyLog(ansiColors.yellow(`[delver]`), 'No local Rust install detected, compilation may fail.');
		fancyLog(ansiColors.yellow(`[delver]`), 'Get rust from: https://rustup.rs/');
	}
};

const targetDir = (release: boolean) => path.join(rootAbs, 'target', release ? 'release' : 'debug');
const outDir = () => path.resolve(import.meta.dirname, '..', 'resources', 'delver', 'bin', platform);

const compileDelver = (release: boolean, callback: (err?: Error) => void) => {
	const args = ['--color', 'always', 'build', '--workspace'];
	if (release) {
		args.push('--release');
	}

	const proc = cp.spawn('cargo', args, {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const stdoutErr: Buffer[] = [];
	proc.stdout.on('data', d => stdoutErr.push(d));
	proc.stderr.on('data', d => stdoutErr.push(d));
	proc.on('error', callback);
	proc.on('exit', code => {
		if (code !== 0) {
			callback(new Error(Buffer.concat(stdoutErr).toString()));
		} else {
			callback();
		}
	});
};

const stageBinaries = (release: boolean) => {
	const target = targetDir(release);
	const out = outDir();
	fs.mkdirSync(out, { recursive: true });
	for (const bin of binaries) {
		const src = path.join(target, bin + binExt);
		const dst = path.join(out, bin + binExt);
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, dst);
		}
	}
};

const compileDelverTask = (release: boolean) => es.map((_, callback: (err?: Error, data?: void) => void) => {
	compileDelver(release, err => {
		if (err) {
			callback(err);
		} else {
			stageBinaries(release);
			callback();
		}
	});
});

const compileDelverDebugTask = task.define('compile-delver', () => {
	warnIfRustNotInstalled();
	return gulp.src(`${root}/Cargo.toml`)
		.pipe(compileDelverTask(false));
});

export const compileDelverReleaseTask = task.define('compile-delver-release', () => {
	warnIfRustNotInstalled();
	return gulp.src(`${root}/Cargo.toml`)
		.pipe(compileDelverTask(true));
});

const watchDelverTask = task.define('watch-delver', () => {
	warnIfRustNotInstalled();
	return watcher([src, ...cargoFiles], { read: false })
		.pipe(debounce(compileDelverDebugTask as task.StreamTask));
});

task.task(compileDelverDebugTask);
task.task(compileDelverReleaseTask);
task.task(watchDelverTask);
