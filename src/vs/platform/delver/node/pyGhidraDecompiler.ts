/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { DecompilerWorkerHost, IDecompilerWorkerInvocation } from './decompilerWorkerHost.js';

const WORKER_SCRIPT_NAME = 'delver_decompiler_worker.py';
const ANALYSIS_PROFILE_VERSION = 'analysis-v1';
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export interface IPyGhidraWorkerConfiguration {
	readonly ghidraHome: string;
	readonly pythonPath: string;
	readonly workerScriptPath: string;
}

export type PyGhidraWorkerDiscovery =
	| { readonly available: true; readonly configuration: IPyGhidraWorkerConfiguration }
	| { readonly available: false; readonly reason: string };

/** Resolves the backend-neutral Python worker shipped in the source tree. */
export function resolvePyGhidraWorkerScriptPath(): string {
	const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(moduleDirectory, '..', '..', '..', '..', '..', 'scripts', 'ghidra', WORKER_SCRIPT_NAME);
}

/** Checks static worker prerequisites. The protocol handshake verifies PyGhidra itself. */
export function discoverPyGhidraWorker(
	ghidraHome: string | undefined,
	pythonPath: string | undefined,
	workerScriptPath = resolvePyGhidraWorkerScriptPath(),
	pathExists: (candidate: string) => boolean = existsSync,
): PyGhidraWorkerDiscovery {
	if (!ghidraHome) {
		return { available: false, reason: 'A Ghidra installation directory is not configured.' };
	}
	if (!pythonPath?.trim()) {
		return { available: false, reason: 'A Python executable is not configured.' };
	}
	if (!pathExists(workerScriptPath)) {
		return { available: false, reason: `Delver's decompiler worker is missing: ${workerScriptPath}` };
	}
	return {
		available: true,
		configuration: {
			ghidraHome: path.resolve(ghidraHome),
			pythonPath: resolvePythonPath(pythonPath.trim(), pathExists),
			workerScriptPath: path.resolve(workerScriptPath),
		},
	};
}

export function resolvePythonPath(
	configured: string,
	pathExists: (candidate: string) => boolean = existsSync,
	platform = process.platform,
	installations: readonly string[] = platform === 'win32' ? windowsPythonInstallations() : [],
): string {
	if (configured.toLowerCase() !== 'auto') {
		return configured;
	}
	if (platform === 'win32') {
		for (const installation of [...installations].sort((left, right) => right.localeCompare(left))) {
			const executable = path.join(installation, 'python.exe');
			const pyGhidraPackage = path.join(installation, 'Lib', 'site-packages', 'pyghidra');
			if (pathExists(executable) && pathExists(pyGhidraPackage)) {
				return executable;
			}
		}
		return 'python';
	}
	return 'python3';
}

function windowsPythonInstallations(): readonly string[] {
	const programs = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python');
	if (!programs || !existsSync(programs)) {
		return [];
	}
	try {
		return readdirSync(programs, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
			.map(entry => path.join(programs, entry.name));
	} catch {
		return [];
	}
}

/** Builds a shell-free invocation of the persistent Python worker. */
export function createPyGhidraWorkerInvocation(configuration: IPyGhidraWorkerConfiguration): IDecompilerWorkerInvocation {
	return {
		command: configuration.pythonPath,
		args: [configuration.workerScriptPath, '--ghidra-home', configuration.ghidraHome],
		options: {
			cwd: path.dirname(configuration.workerScriptPath),
			env: { ...process.env, GHIDRA_INSTALL_DIR: configuration.ghidraHome },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		},
	};
}

/** Returns the persistent Ghidra project directory for an immutable target. */
export function pyGhidraProjectDirectory(cacheRoot: string, backendVersion: string, contentHash: string): string {
	if (!CONTENT_HASH_PATTERN.test(contentHash)) {
		throw new Error('A valid SHA-256 content hash is required for the Ghidra project cache');
	}
	return path.join(cacheRoot, `ghidra-${backendVersion}`, ANALYSIS_PROFILE_VERSION, contentHash.toLowerCase());
}

/** Maintains analyzed targets in one persistent PyGhidra process. */
export class PyGhidraDecompiler extends Disposable {
	private readonly worker: DecompilerWorkerHost;
	private readonly openedTargets = new Map<string, string>();
	private readonly openingTargets = new Map<string, { readonly contentHash: string; readonly operation: Promise<number> }>();
	private openedTargetsGeneration = 0;

	constructor(configuration: IPyGhidraWorkerConfiguration, private readonly cacheRoot: string, worker?: DecompilerWorkerHost) {
		super();
		this.worker = this._register(worker ?? new DecompilerWorkerHost(createPyGhidraWorkerInvocation(configuration)));
	}

	async status(): Promise<{ readonly backendId: string; readonly backendVersion: string; readonly adapterVersion: string; readonly label: string; readonly processGeneration: number; readonly spawnMs: number; readonly handshakeMs: number }> {
		const details = await this.worker.details();
		return { backendId: details.hello.backend.id, backendVersion: details.hello.backend.version, adapterVersion: details.hello.backend.adapterVersion ?? 'unknown', label: details.hello.backend.label, processGeneration: details.generation, spawnMs: details.spawnMs, handshakeMs: details.handshakeMs };
	}

	async decompileFunction(targetId: string, targetPath: string, contentHash: string, functionRva: string, token: CancellationToken): Promise<{ readonly serialized: string; readonly targetOpenMs: number; readonly functionRecoveryMs: number; readonly decompilationMs: number; readonly serializationMs: number }> {
		const targetOpenMs = await this.prepareTarget(targetId, targetPath, contentHash, token);
		const result = await this.worker.request('decompileFunction', { targetId, functionRva }, token);
		const timings = readWorkerTimings(result);
		// Timings describe the worker transport and are not part of the versioned
		// decompiler payload consumed by the strict workbench decoder or project DB.
		const serializedResult = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'timings'));
		return { serialized: JSON.stringify(serializedResult), targetOpenMs, ...timings };
	}

	async prepareTarget(targetId: string, targetPath: string, contentHash: string, token: CancellationToken = CancellationToken.None): Promise<number> {
		const hello = await this.worker.start();
		if (this.openedTargetsGeneration !== this.worker.generation) {
			this.openedTargets.clear();
			this.openingTargets.clear();
			this.openedTargetsGeneration = this.worker.generation;
		}
		if (this.openedTargets.get(targetId) === contentHash) {
			return 0;
		}
		const existing = this.openingTargets.get(targetId);
		if (existing) {
			if (existing.contentHash !== contentHash) {
				throw new Error(`Target '${targetId}' is already being prepared for different content.`);
			}
			return existing.operation;
		}
		const projectDirectory = pyGhidraProjectDirectory(this.cacheRoot, hello.backend.version, contentHash);
		const operation = this.openTarget(targetId, targetPath, contentHash, projectDirectory, token);
		this.openingTargets.set(targetId, { contentHash, operation });
		try {
			return await operation;
		} finally {
			if (this.openingTargets.get(targetId)?.operation === operation) {
				this.openingTargets.delete(targetId);
			}
		}
	}

	async closeTarget(targetId: string): Promise<void> {
		try {
			await this.openingTargets.get(targetId)?.operation;
		} catch {
			// A failed preparation has no target to close.
		}
		if (!this.openedTargets.delete(targetId)) {
			return;
		}
		await this.worker.request('closeTarget', { targetId }, CancellationToken.None);
	}

	private async openTarget(targetId: string, targetPath: string, contentHash: string, projectDirectory: string, token: CancellationToken): Promise<number> {
		const openStarted = Date.now();
		await this.worker.request('openTarget', { targetId, targetPath, contentHash, projectDirectory }, token);
		this.openedTargets.set(targetId, contentHash);
		return Date.now() - openStarted;
	}
}

function readWorkerTimings(result: object): { readonly functionRecoveryMs: number; readonly decompilationMs: number; readonly serializationMs: number } {
	const timings = (result as { timings?: Partial<Record<'functionRecoveryMs' | 'decompilationMs' | 'serializationMs', number>> }).timings;
	return {
		functionRecoveryMs: timings?.functionRecoveryMs ?? 0,
		decompilationMs: timings?.decompilationMs ?? 0,
		serializationMs: timings?.serializationMs ?? 0,
	};
}
