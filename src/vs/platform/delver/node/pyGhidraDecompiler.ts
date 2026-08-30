/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { IDelverDecompilationSemanticsWire } from '../common/delverAnalysisService.js';
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
	private readonly openedTargets = new Map<string, { readonly contentHash: string; readonly workerTargetId: string }>();
	private readonly openedContentTargets = new Map<string, { readonly workerTargetId: string; readonly targetIds: Set<string> }>();
	private readonly openingTargets = new Map<string, { readonly contentHash: string; readonly operation: Promise<number> }>();
	private readonly openingContentTargets = new Map<string, { readonly workerTargetId: string; readonly targetIds: Set<string>; readonly operation: Promise<number> }>();
	private openedTargetsGeneration = 0;

	constructor(configuration: IPyGhidraWorkerConfiguration, private readonly cacheRoot: string, worker?: DecompilerWorkerHost) {
		super();
		this.worker = this._register(worker ?? new DecompilerWorkerHost(createPyGhidraWorkerInvocation(configuration)));
	}

	async status(): Promise<{ readonly backendId: string; readonly backendVersion: string; readonly adapterVersion: string; readonly label: string; readonly processGeneration: number; readonly spawnMs: number; readonly handshakeMs: number }> {
		const details = await this.worker.details();
		return { backendId: details.hello.backend.id, backendVersion: details.hello.backend.version, adapterVersion: details.hello.backend.adapterVersion ?? 'unknown', label: details.hello.backend.label, processGeneration: details.generation, spawnMs: details.spawnMs, handshakeMs: details.handshakeMs };
	}

	async shutdown(): Promise<void> {
		await this.worker.shutdown();
	}

	async decompileFunction(targetId: string, targetPath: string, contentHash: string, functionRva: string, semantics: IDelverDecompilationSemanticsWire, token: CancellationToken): Promise<{ readonly serialized: string; readonly targetOpenMs: number; readonly functionRecoveryMs: number; readonly decompilationMs: number; readonly serializationMs: number }> {
		const targetOpenMs = await this.prepareTarget(targetId, targetPath, contentHash, token);
		const workerTargetId = this.openedTargets.get(targetId)?.workerTargetId;
		if (!workerTargetId) {
			throw new Error(`Target '${targetId}' was not retained after preparation.`);
		}
		const result = await this.worker.request('decompileFunction', { targetId: workerTargetId, functionRva, semantics }, token);
		const timings = readWorkerTimings(result);
		// Timings describe the worker transport and are not part of the versioned
		// decompiler payload consumed by the strict workbench decoder or project DB.
		const serializedResult = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'timings'));
		return { serialized: JSON.stringify(serializedResult), targetOpenMs, ...timings };
	}

	/**
	 * Finishes the backend's analysis of one target.
	 *
	 * `openTarget` imports without auto-analysis because pseudocode for a single
	 * function does not need it. Anything reasoning about the whole function set
	 * does, so the cost is asked for explicitly rather than hidden inside
	 * another call (ADR 0017). Idempotent, and cancellable — it takes minutes on
	 * a large image.
	 *
	 * `undefined` when the backend does not advertise the capability.
	 */
	async analyzeTarget(targetId: string, targetPath: string, contentHash: string, token: CancellationToken): Promise<{ readonly analysisComplete: boolean; readonly alreadyAnalyzed: boolean } | undefined> {
		const hello = await this.worker.start();
		if (hello.capabilities?.analyzeTarget !== true) {
			return undefined;
		}
		await this.prepareTarget(targetId, targetPath, contentHash, token);
		const workerTargetId = this.openedTargets.get(targetId)?.workerTargetId;
		if (!workerTargetId) {
			throw new Error(`Target '${targetId}' was not retained after preparation.`);
		}
		const result = await this.worker.request('analyzeTarget', { targetId: workerTargetId }, token);
		const record = result as { analysisComplete?: unknown; alreadyAnalyzed?: unknown };
		return {
			analysisComplete: record.analysisComplete === true,
			alreadyAnalyzed: record.alreadyAnalyzed === true,
		};
	}

	/**
	 * Every function the backend recovered in one target.
	 *
	 * The handshake's backend side (ADR 0017). Returns `undefined` when the
	 * backend does not advertise the capability, which a caller must not read as
	 * "the sets agree" — it is the absence of an answer, not an empty one.
	 */
	async listFunctions(targetId: string, targetPath: string, contentHash: string, token: CancellationToken): Promise<IDecompilerBackendFunctionSet | undefined> {
		const hello = await this.worker.start();
		if (hello.capabilities?.listFunctions !== true) {
			return undefined;
		}
		await this.prepareTarget(targetId, targetPath, contentHash, token);
		const workerTargetId = this.openedTargets.get(targetId)?.workerTargetId;
		if (!workerTargetId) {
			throw new Error(`Target '${targetId}' was not retained after preparation.`);
		}
		const result = await this.worker.request('listFunctions', { targetId: workerTargetId }, token);
		return {
			functions: readBackendFunctions(result),
			// Absent is not "complete". A worker too old to report this has not
			// told us the program was analyzed, and guessing that it was turns a
			// partial import into a pile of fake disagreements.
			analysisComplete: (result as { analysisComplete?: unknown }).analysisComplete === true,
		};
	}

	async prepareTarget(targetId: string, targetPath: string, contentHash: string, token: CancellationToken = CancellationToken.None): Promise<number> {
		const hello = await this.worker.start();
		if (this.openedTargetsGeneration !== this.worker.generation) {
			this.openedTargets.clear();
			this.openedContentTargets.clear();
			this.openingTargets.clear();
			this.openingContentTargets.clear();
			this.openedTargetsGeneration = this.worker.generation;
		}
		const openedTarget = this.openedTargets.get(targetId);
		if (openedTarget?.contentHash === contentHash) {
			return 0;
		}
		if (openedTarget) {
			throw new Error(`Target '${targetId}' is already prepared for different content.`);
		}
		const existing = this.openingTargets.get(targetId);
		if (existing) {
			if (existing.contentHash !== contentHash) {
				throw new Error(`Target '${targetId}' is already being prepared for different content.`);
			}
			const elapsed = await existing.operation;
			if (!this.openedTargets.has(targetId)) {
				throw new Error(`Target '${targetId}' was not retained after preparation.`);
			}
			return elapsed;
		}
		const openedContentTarget = this.openedContentTargets.get(contentHash);
		if (openedContentTarget) {
			this.retainTarget(targetId, contentHash, openedContentTarget);
			return 0;
		}
		const projectDirectory = pyGhidraProjectDirectory(this.cacheRoot, hello.backend.version, contentHash);
		const openingContentTarget = this.openingContentTargets.get(contentHash);
		const workerTargetId = openingContentTarget?.workerTargetId ?? targetId;
		let operation: Promise<number>;
		if (openingContentTarget) {
			openingContentTarget.targetIds.add(targetId);
			operation = openingContentTarget.operation;
		} else {
			const targetIds = new Set([targetId]);
			operation = this.openTarget(workerTargetId, targetPath, contentHash, projectDirectory, token).then(elapsed => {
				const contentTarget = { workerTargetId, targetIds: new Set(targetIds) };
				this.openedContentTargets.set(contentHash, contentTarget);
				for (const retainedTargetId of targetIds) {
					this.openedTargets.set(retainedTargetId, { contentHash, workerTargetId });
				}
				return elapsed;
			});
			this.openingContentTargets.set(contentHash, { workerTargetId, targetIds, operation });
		}
		this.openingTargets.set(targetId, { contentHash, operation });
		try {
			const elapsed = await operation;
			const openedTarget = this.openedTargets.get(targetId);
			if (!openedTarget || openedTarget.workerTargetId !== workerTargetId) {
				throw new Error(`Target '${targetId}' was not retained after preparation.`);
			}
			return openingContentTarget ? 0 : elapsed;
		} finally {
			if (this.openingTargets.get(targetId)?.operation === operation) {
				this.openingTargets.delete(targetId);
			}
			if (this.openingContentTargets.get(contentHash)?.operation === operation) {
				this.openingContentTargets.delete(contentHash);
			}
		}
	}

	async closeTarget(targetId: string): Promise<void> {
		try {
			await this.openingTargets.get(targetId)?.operation;
		} catch {
			// A failed preparation has no target to close.
		}
		const openedTarget = this.openedTargets.get(targetId);
		if (!openedTarget) {
			return;
		}
		this.openedTargets.delete(targetId);
		const contentTarget = this.openedContentTargets.get(openedTarget.contentHash);
		if (!contentTarget) {
			return;
		}
		contentTarget.targetIds.delete(targetId);
		if (contentTarget.targetIds.size > 0) {
			return;
		}
		this.openedContentTargets.delete(openedTarget.contentHash);
		await this.worker.request('closeTarget', { targetId: contentTarget.workerTargetId }, CancellationToken.None);
	}

	private retainTarget(targetId: string, contentHash: string, contentTarget: { readonly workerTargetId: string; readonly targetIds: Set<string> }): void {
		contentTarget.targetIds.add(targetId);
		this.openedTargets.set(targetId, { contentHash, workerTargetId: contentTarget.workerTargetId });
	}

	private async openTarget(targetId: string, targetPath: string, contentHash: string, projectDirectory: string, token: CancellationToken): Promise<number> {
		const openStarted = Date.now();
		try {
			await this.worker.request('openTarget', { targetId, targetPath, contentHash, projectDirectory }, token);
		} catch (error) {
			if (!isUnrecognizedCachedProject(error)) {
				throw error;
			}
			await fs.rm(projectDirectory, { recursive: true, force: true });
			await this.worker.request('openTarget', { targetId, targetPath, contentHash, projectDirectory }, token);
		}
		return Date.now() - openStarted;
	}
}

function isUnrecognizedCachedProject(error: unknown): boolean {
	return error instanceof Error && /Unrecognized file format/i.test(error.message);
}

/** What a backend recovered, and whether it had finished looking. */
export interface IDecompilerBackendFunctionSet {
	readonly functions: readonly IDecompilerBackendFunction[];
	/**
	 * Whether the backend's analysis had completed when it answered.
	 *
	 * PyGhidra imports without auto-analysis and recovers functions on demand,
	 * so a set taken early is a fraction of what the backend would eventually
	 * find. Comparing that against a complete set reports the shortfall as
	 * disagreement, which is a confident false claim about both tools.
	 */
	readonly analysisComplete: boolean;
}

/** One function a decompiler backend reports having recovered. */
export interface IDecompilerBackendFunction {
	/** Image-relative entry, as a `"0x…"` string (ADR 0001). */
	readonly rva: string;
	/** Exclusive end, absent when the backend has no body for it. */
	readonly endRva: string | undefined;
	readonly name: string;
}

/**
 * Reads a `listFunctions` payload, refusing anything malformed.
 *
 * A backend's function set is one half of the handshake, so a payload that is
 * partly unreadable must fail rather than silently under-report — a short list
 * reads downstream as the backend having recovered less, which is a claim about
 * the backend that nothing here is entitled to make.
 */
export function readBackendFunctions(result: object): readonly IDecompilerBackendFunction[] {
	const functions = (result as { functions?: unknown }).functions;
	if (!Array.isArray(functions)) {
		throw new Error('listFunctions response has no functions array.');
	}
	return functions.map((entry, index) => {
		if (typeof entry !== 'object' || entry === null) {
			throw new Error(`listFunctions functions[${index}] is not an object.`);
		}
		const candidate = entry as { rva?: unknown; endRva?: unknown; name?: unknown };
		if (typeof candidate.rva !== 'string' || !/^0x[0-9a-f]+$/.test(candidate.rva)) {
			throw new Error(`listFunctions functions[${index}].rva is not a canonical "0x…" string.`);
		}
		if (candidate.endRva !== undefined && candidate.endRva !== null && (typeof candidate.endRva !== 'string' || !/^0x[0-9a-f]+$/.test(candidate.endRva))) {
			throw new Error(`listFunctions functions[${index}].endRva is not a canonical "0x…" string.`);
		}
		if (typeof candidate.name !== 'string') {
			throw new Error(`listFunctions functions[${index}].name is not a string.`);
		}
		return {
			rva: candidate.rva,
			endRva: typeof candidate.endRva === 'string' ? candidate.endRva : undefined,
			name: candidate.name,
		};
	});
}

function readWorkerTimings(result: object): { readonly functionRecoveryMs: number; readonly decompilationMs: number; readonly serializationMs: number } {
	const timings = (result as { timings?: Partial<Record<'functionRecoveryMs' | 'decompilationMs' | 'serializationMs', number>> }).timings;
	return {
		functionRecoveryMs: timings?.functionRecoveryMs ?? 0,
		decompilationMs: timings?.decompilationMs ?? 0,
		serializationMs: timings?.serializationMs ?? 0,
	};
}
