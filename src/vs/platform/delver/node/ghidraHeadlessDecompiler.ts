/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import * as path from '../../../base/common/path.js';
import { killTree } from '../../../base/node/processes.js';
import { resolveGhidraScript } from './delverBinaries.js';

export const GHIDRA_PINNED_VERSION = '12.1';

const SCRIPT_NAME = 'DelverDecompile.java';
const WINDOWS_WRAPPER = `@echo off
"%DELVER_GHIDRA_LAUNCHER%" "%DELVER_GHIDRA_PROJECT_DIR%" delver -import "%DELVER_GHIDRA_TARGET%" -scriptPath "%DELVER_GHIDRA_SCRIPT_DIR%" -postScript ${SCRIPT_NAME} "%DELVER_GHIDRA_RVA%" "%DELVER_GHIDRA_OUTPUT%" -deleteProject
`;

export interface IGhidraHeadlessInstallation {
	readonly home: string;
	readonly launcherPath: string;
	readonly scriptPath: string;
}

export type GhidraHeadlessDiscovery =
	| { readonly available: true; readonly installation: IGhidraHeadlessInstallation }
	| { readonly available: false; readonly reason: string };

export interface IGhidraHeadlessInvocation {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

/**
 * Locates the script used by the headless fallback backend: `scripts/ghidra/` in a
 * checkout, the staged `resources/delver/ghidra/` copy in a packaged build.
 */
export function resolveGhidraScriptPath(): string {
	return resolveGhidraScript(SCRIPT_NAME);
}

/** Validates a configured Ghidra home without searching or mutating the host. */
export function discoverGhidraHeadless(
	configuredHome: string | undefined,
	scriptPath = resolveGhidraScriptPath(),
	platform = process.platform,
	pathExists: (candidate: string) => boolean = existsSync,
): GhidraHeadlessDiscovery {
	if (!configuredHome) {
		return { available: false, reason: `Configure a Ghidra ${GHIDRA_PINNED_VERSION} installation directory.` };
	}

	const home = path.resolve(configuredHome);
	const launcherPath = path.join(home, 'support', platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
	if (!pathExists(launcherPath)) {
		return { available: false, reason: `The configured Ghidra installation has no headless launcher: ${launcherPath}` };
	}
	if (!pathExists(scriptPath)) {
		return { available: false, reason: `Delver's Ghidra headless script is missing: ${scriptPath}` };
	}

	return { available: true, installation: { home, launcherPath, scriptPath: path.resolve(scriptPath) } };
}

/** Builds a shell-free Unix invocation or a fixed Windows wrapper invocation. */
export function createGhidraInvocation(
	installation: IGhidraHeadlessInstallation,
	targetPath: string,
	functionRva: string,
	temporaryDirectory: string,
	outputPath: string,
	platform = process.platform,
	commandInterpreter = process.env.ComSpec || 'cmd.exe',
): IGhidraHeadlessInvocation {
	const scriptDirectory = path.dirname(installation.scriptPath);
	if (platform === 'win32') {
		return {
			command: commandInterpreter,
			args: ['/d', '/q', '/v:off', '/c', 'delver-ghidra.cmd'],
			options: {
				cwd: temporaryDirectory,
				env: {
					...process.env,
					DELVER_GHIDRA_LAUNCHER: installation.launcherPath,
					DELVER_GHIDRA_PROJECT_DIR: temporaryDirectory,
					DELVER_GHIDRA_TARGET: targetPath,
					DELVER_GHIDRA_SCRIPT_DIR: scriptDirectory,
					DELVER_GHIDRA_RVA: functionRva,
					DELVER_GHIDRA_OUTPUT: outputPath,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			},
		};
	}

	return {
		command: installation.launcherPath,
		args: [
			temporaryDirectory,
			'delver',
			'-import', targetPath,
			'-scriptPath', scriptDirectory,
			'-postScript', SCRIPT_NAME, functionRva, outputPath,
			'-deleteProject',
		],
		options: {
			cwd: temporaryDirectory,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	};
}

/** Runs one isolated headless project and returns the script's JSON output. */
export async function runGhidraHeadless(
	installation: IGhidraHeadlessInstallation,
	targetPath: string,
	expectedContentHash: string,
	functionRva: string,
	token: CancellationToken,
): Promise<string> {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}

	const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), 'delver-ghidra-'));
	const outputPath = path.join(temporaryDirectory, 'decompiled.json');
	const snapshotPath = path.join(temporaryDirectory, 'target-image');
	try {
		await fs.copyFile(targetPath, snapshotPath);
		const snapshotHash = await sha256File(snapshotPath);
		if (snapshotHash !== expectedContentHash) {
			throw new Error('The target changed after the Delver analysis session was opened.');
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		if (process.platform === 'win32') {
			await fs.writeFile(path.join(temporaryDirectory, 'delver-ghidra.cmd'), WINDOWS_WRAPPER, { encoding: 'utf8', flag: 'wx' });
		}

		const invocation = createGhidraInvocation(installation, snapshotPath, functionRva, temporaryDirectory, outputPath);
		const child = spawn(invocation.command, [...invocation.args], invocation.options);
		const diagnostics = await waitForGhidra(child, token);
		try {
			return await fs.readFile(outputPath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
			throw new Error(`Ghidra finished without producing decompiled output.\n${diagnostics || 'Ghidra reported no diagnostic output.'}`);
		}
	}
	finally {
		await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
	}
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

function waitForGhidra(child: ChildProcess, token: CancellationToken): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let standardOutput = '';
		let standardError = '';
		let cancelled = false;
		let settled = false;
		child.stdout?.on('data', (chunk: Buffer) => {
			standardOutput = `${standardOutput}${chunk.toString()}`.slice(-32_768);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			standardError = `${standardError}${chunk.toString()}`.slice(-32_768);
		});

		const cancellationListener = token.onCancellationRequested(() => {
			cancelled = true;
			if (child.pid !== undefined) {
				void killTree(child.pid, true).catch(() => child.kill());
			} else {
				child.kill();
			}
		});
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cancellationListener.dispose();
			if (error) {
				reject(error);
			} else {
				resolve([standardError.trim(), standardOutput.trim()].filter(Boolean).join('\n'));
			}
		};

		child.once('error', error => finish(error));
		child.once('exit', code => {
			if (cancelled) {
				finish(new CancellationError());
			} else if (code !== 0) {
				finish(new Error(`Ghidra exited with code ${code}: ${[standardError.trim(), standardOutput.trim()].filter(Boolean).join('\n') || 'no diagnostic output'}`));
			} else {
				finish();
			}
		});
	});
}
