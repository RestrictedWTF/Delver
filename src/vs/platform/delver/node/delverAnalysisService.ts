/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dirent, promises as fs } from 'fs';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, isAbsolute, join, normalize } from '../../../base/common/path.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import {
	AnalysisSessionId,
	DelverDecompilerStatusWire,
	IAnalysisSessionHandle,
	IDelverDecompilerCacheInfoWire,
	IDelverDecompilerTargetPreparationWire,
	IDelverDecompilationSemanticsWire,
	IDelverBackendAnalysisWire, IDelverBackendFunctionsWire, IDelverBackendProgressWire, IDelverDecompilationWire,
	IDelverAnalysisService,
	IDelverReadMemoryWire,
} from '../common/delverAnalysisService.js';
import { IBasicBlocksResult, ICallGraphResult, ICallPathsResult, IDataRangeCorrectionWire,
	IFunctionCorrectionWire, IFunctionProfileResult, IFunctionsResult, IGetExportsResult, IGetImageInfoResult, IGetImportsResult, IGlobalAccessesResult, IGlobalsResult, IListingWindowResult, IScanStringsResult, ISearchImmediatesResult, ISetCorrectionsResult, IStringsResult, IVtablesResult, IXrefIndexResult, IXrefsResult } from '../common/protocol.generated.js';
import { TargetConfig } from '../common/target.js';
import { DelverAnalysisSession } from './analysisSession.js';
import { discoverGhidraHeadless, GHIDRA_PINNED_VERSION, runGhidraHeadless } from './ghidraHeadlessDecompiler.js';
import { discoverPyGhidraWorker, PyGhidraDecompiler } from './pyGhidraDecompiler.js';

/**
 * Hosts analysis sessions for the renderer.
 *
 * Sessions are keyed by an opaque id rather than handed out as objects, because
 * the consumer is on the other side of an IPC channel and can only hold values
 * that survive serialization.
 */
export class DelverAnalysisService extends Disposable implements IDelverAnalysisService {
	readonly _serviceBrand: undefined;

	private readonly sessions = new Map<AnalysisSessionId, DelverAnalysisSession>();
	private readonly decompilations = new Map<string, { readonly sessionId: AnalysisSessionId; readonly source: CancellationTokenSource }>();
	private readonly pyGhidra = this._register(new MutableDisposable<PyGhidraDecompiler>());
	private readonly retiring = new Set<PyGhidraDecompiler>();
	private readonly pyGhidraCacheRoot: string;
	private pyGhidraKey: string | undefined;
	private nextId = 1;

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
	) {
		super();
		this.pyGhidraCacheRoot = join(environmentService.userDataPath, 'delver', 'decompiler-cache');
		this._register({ dispose: () => this.closeAll() });
	}

	async openImage(config: TargetConfig): Promise<IAnalysisSessionHandle> {
		const session = await DelverAnalysisSession.start(config);
		const sessionId = `analysis-${this.nextId++}`;
		this.sessions.set(sessionId, session);
		return { sessionId, image: session.image };
	}

	async listingWindow(sessionId: AnalysisSessionId, startRow: number, count: number): Promise<IListingWindowResult> {
		return this.session(sessionId).listingWindow(startRow, count);
	}

	async rowForAddress(sessionId: AnalysisSessionId, rva: string, containing: boolean): Promise<number | undefined> {
		return this.session(sessionId).rowForAddress(BigInt(rva), containing);
	}

	async addressForRow(sessionId: AnalysisSessionId, row: number): Promise<string | undefined> {
		const rva = await this.session(sessionId).addressForRow(row);
		// Back to the wire form before this crosses the channel: a bigint here
		// would hang the caller rather than fail (ADR 0001, "Scope").
		return rva === undefined ? undefined : `0x${rva.toString(16).toUpperCase()}`;
	}

	async functions(sessionId: AnalysisSessionId): Promise<IFunctionsResult> {
		return this.session(sessionId).functions();
	}

	async basicBlocks(sessionId: AnalysisSessionId, functionRva: string, maxBlocks: number): Promise<IBasicBlocksResult> {
		return this.session(sessionId).basicBlocks(BigInt(functionRva), maxBlocks);
	}

	async callGraph(sessionId: AnalysisSessionId, functionRva: string, maxEdges: number): Promise<ICallGraphResult> {
		return this.session(sessionId).callGraph(BigInt(functionRva), maxEdges);
	}

	async callPaths(sessionId: AnalysisSessionId, fromRva: string, toRva: string, maxDepth: number, maxPaths: number, maxVisited: number): Promise<ICallPathsResult> {
		return this.session(sessionId).callPaths(BigInt(fromRva), BigInt(toRva), maxDepth, maxPaths, maxVisited);
	}

	async functionProfile(sessionId: AnalysisSessionId, functionRva: string): Promise<IFunctionProfileResult> {
		return this.session(sessionId).functionProfile(BigInt(functionRva));
	}

	async globals(sessionId: AnalysisSessionId, start: number, maxGlobals: number): Promise<IGlobalsResult> {
		return this.session(sessionId).globals(start, maxGlobals);
	}

	async globalAccesses(sessionId: AnalysisSessionId, rva: string, maxAccesses: number): Promise<IGlobalAccessesResult> {
		return this.session(sessionId).globalAccesses(BigInt(rva), maxAccesses);
	}

	async vtables(sessionId: AnalysisSessionId, start: number, maxVtables: number, maxSlotsPerVtable: number): Promise<IVtablesResult> {
		return this.session(sessionId).vtables(start, maxVtables, maxSlotsPerVtable);
	}

	async imageInfo(sessionId: AnalysisSessionId): Promise<IGetImageInfoResult> {
		return this.session(sessionId).getImageInfo();
	}

	async imports(sessionId: AnalysisSessionId): Promise<IGetImportsResult> {
		return this.session(sessionId).getImports();
	}

	async exports(sessionId: AnalysisSessionId): Promise<IGetExportsResult> {
		return this.session(sessionId).getExports();
	}

	async strings(sessionId: AnalysisSessionId): Promise<IStringsResult> {
		return this.session(sessionId).strings();
	}

	async xrefsTo(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult> {
		return this.session(sessionId).xrefsTo(BigInt(rva));
	}

	async xrefsFrom(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult> {
		return this.session(sessionId).xrefsFrom(BigInt(rva));
	}

	async xrefIndex(sessionId: AnalysisSessionId, start: number, maxXrefs: number, generation?: number): Promise<IXrefIndexResult> {
		return this.session(sessionId).xrefIndex(start, maxXrefs, generation);
	}

	async setCorrections(
		sessionId: AnalysisSessionId,
		corrections: readonly IFunctionCorrectionWire[],
		dataRanges: readonly IDataRangeCorrectionWire[] = [],
	): Promise<ISetCorrectionsResult> {
		return this.session(sessionId).setCorrections(corrections, dataRanges);
	}

	async scanStrings(sessionId: AnalysisSessionId, fromRva: string, maxStrings: number): Promise<IScanStringsResult> {
		return this.session(sessionId).scanStrings(fromRva, maxStrings);
	}

	async searchImmediates(sessionId: AnalysisSessionId, value: string, width: number | undefined, maxMatches: number): Promise<ISearchImmediatesResult> {
		return this.session(sessionId).searchImmediates(value, width, maxMatches);
	}

	async readMemory(sessionId: AnalysisSessionId, space: 'image' | 'file', address: string, count: number): Promise<IDelverReadMemoryWire> {
		return this.session(sessionId).readMemory(space === 'image' ? 'Image' : 'File', BigInt(address), count);
	}

	async decompilerStatus(ghidraHome: string | undefined, pythonPath: string | undefined, backend: 'pyghidra' | 'headless' = 'pyghidra'): Promise<DelverDecompilerStatusWire> {
		if (backend === 'headless') {
			const discovery = discoverGhidraHeadless(ghidraHome);
			return discovery.available
				? { state: 'ready', backendId: 'ghidra-headless', backendVersion: GHIDRA_PINNED_VERSION, adapterVersion: 'headless-script-v1', label: `Ghidra ${GHIDRA_PINNED_VERSION} (Headless)`, processGeneration: 0, spawnMs: 0, handshakeMs: 0 }
				: { state: 'unconfigured', reason: discovery.reason };
		}
		const workerDiscovery = discoverPyGhidraWorker(ghidraHome, pythonPath);
		if (!workerDiscovery.available) {
			return { state: 'unconfigured', reason: workerDiscovery.reason };
		}
		try {
			const status = await this.getPyGhidra(workerDiscovery.configuration).status();
			return { state: 'ready', ...status };
		} catch (error) {
			await this.resetPyGhidra();
			const diagnostic = `${errorMessage(error)}\nPython executable: ${workerDiscovery.configuration.pythonPath}`;
			return { state: 'failed', reason: 'PyGhidra failed to start.', diagnostic };
		}
	}

	async restartDecompiler(ghidraHome: string | undefined, pythonPath: string | undefined, backend: 'pyghidra' | 'headless' = 'pyghidra'): Promise<DelverDecompilerStatusWire> {
		if (backend === 'pyghidra') {
			for (const operation of this.decompilations.values()) {
				operation.source.cancel();
			}
			await this.resetPyGhidra();
		}
		return this.decompilerStatus(ghidraHome, pythonPath, backend);
	}

	decompilerCacheInfo(): Promise<IDelverDecompilerCacheInfoWire> {
		return measureDecompilerCache(this.pyGhidraCacheRoot);
	}

	async clearDecompilerCache(): Promise<IDelverDecompilerCacheInfoWire> {
		const previous = await this.decompilerCacheInfo();
		for (const operation of this.decompilations.values()) {
			operation.source.cancel();
		}
		await this.resetPyGhidra();
		assertSafeDecompilerCacheRoot(this.pyGhidraCacheRoot);
		await fs.rm(this.pyGhidraCacheRoot, { recursive: true, force: true });
		return previous;
	}

	private readonly _onDidReportBackendProgress = this._register(new Emitter<IDelverBackendProgressWire>());
	readonly onDidReportBackendProgress = this._onDidReportBackendProgress.event;

	async analyzeBackendTarget(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string, backend: 'pyghidra' | 'headless', operationId: string): Promise<IDelverBackendAnalysisWire | undefined> {
		if (backend !== 'pyghidra') {
			return undefined;
		}
		const workerDiscovery = discoverPyGhidraWorker(ghidraHome, pythonPath);
		if (!workerDiscovery.available) {
			throw new Error(workerDiscovery.reason);
		}
		if (this.decompilations.has(operationId)) {
			throw new Error(`Duplicate decompiler operation ${operationId}`);
		}
		// Registered like a decompilation so `cancelDecompile` reaches it: this
		// runs for minutes and an analyst who changes their mind must be able to
		// stop it.
		const source = new CancellationTokenSource();
		this.decompilations.set(operationId, { sessionId, source });
		try {
			const decompiler = this.getPyGhidra(workerDiscovery.configuration);
			return await decompiler.analyzeTarget(
				sessionId,
				this.session(sessionId).targetPath,
				contentHash,
				source.token,
				progress => this._onDidReportBackendProgress.fire({ operationId, message: progress.message, fraction: progress.fraction }),
			);
		} finally {
			this.decompilations.delete(operationId);
			source.dispose();
		}
	}

	async listBackendFunctions(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string, backend: 'pyghidra' | 'headless'): Promise<IDelverBackendFunctionsWire | undefined> {
		// Only the persistent PyGhidra worker can be asked what it recovered. The
		// headless backend runs one function at a time and never holds a program,
		// so it advertises nothing and the handshake is simply absent for it —
		// which is a different claim from the sets agreeing (ADR 0017).
		if (backend !== 'pyghidra') {
			return undefined;
		}
		const workerDiscovery = discoverPyGhidraWorker(ghidraHome, pythonPath);
		if (!workerDiscovery.available) {
			throw new Error(workerDiscovery.reason);
		}
		const decompiler = this.getPyGhidra(workerDiscovery.configuration);
		const status = await decompiler.status();
		const functions = await decompiler.listFunctions(
			sessionId,
			this.session(sessionId).targetPath,
			contentHash,
			CancellationToken.None,
		);
		if (!functions) {
			return undefined;
		}
		return {
			backendId: status.backendId,
			backendVersion: status.backendVersion,
			functions: functions.functions,
			analysisComplete: functions.analysisComplete,
		};
	}

	async decompileFunction(sessionId: AnalysisSessionId, rva: string, contentHash: string, ghidraHome: string, pythonPath: string, operationId: string, backend: 'pyghidra' | 'headless', semantics: IDelverDecompilationSemanticsWire): Promise<IDelverDecompilationWire> {
		if (this.decompilations.has(operationId)) {
			throw new Error(`Duplicate decompiler operation ${operationId}`);
		}
		const source = new CancellationTokenSource();
		this.decompilations.set(operationId, { sessionId, source });
		try {
			if (backend === 'pyghidra') {
				const workerDiscovery = discoverPyGhidraWorker(ghidraHome, pythonPath);
				if (!workerDiscovery.available) {
					throw new Error(workerDiscovery.reason);
				}
				const decompiler = this.getPyGhidra(workerDiscovery.configuration);
				try {
					const status = await decompiler.status();
					const result = await decompiler.decompileFunction(
						sessionId,
						this.session(sessionId).targetPath,
						contentHash,
						rva,
						semantics,
						source.token,
					);
					return {
						backendId: status.backendId,
						backendVersion: status.backendVersion,
						adapterVersion: status.adapterVersion,
						processGeneration: status.processGeneration,
						timings: { spawnMs: status.spawnMs, handshakeMs: status.handshakeMs, targetOpenMs: result.targetOpenMs, functionRecoveryMs: result.functionRecoveryMs, decompilationMs: result.decompilationMs, serializationMs: result.serializationMs },
						serialized: result.serialized,
					};
				} catch (error) {
					if (isCancellationError(error)) {
						// The user pressed Escape; the backend is fine. Wrapping this in a
						// generic failure is what marks the decompiler dead until restart.
						// `instanceof` does not survive the shared-process boundary but the
						// error's `name` and `message` do (ADR 0001, "Scope"), so rethrow the
						// canonical cancellation shape rather than a description of it.
						throw new CancellationError();
					}
					throw new Error(`PyGhidra decompilation failed. Delver did not start the slow headless backend automatically.\n${errorMessage(error)}`);
				}
			}

			const discovery = discoverGhidraHeadless(ghidraHome);
			if (!discovery.available) {
				throw new Error(discovery.reason);
			}
			const started = Date.now();
			const serialized = await runGhidraHeadless(discovery.installation, this.session(sessionId).targetPath, contentHash, rva, source.token);
			return {
				backendId: 'ghidra-headless',
				backendVersion: GHIDRA_PINNED_VERSION,
				adapterVersion: 'headless-script-v1',
				processGeneration: 1,
				timings: { spawnMs: 0, handshakeMs: 0, targetOpenMs: 0, functionRecoveryMs: 0, decompilationMs: Date.now() - started, serializationMs: 0 },
				serialized,
			};
		}
		finally {
			this.decompilations.delete(operationId);
			source.dispose();
		}
	}

	async prepareDecompilerTarget(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string): Promise<IDelverDecompilerTargetPreparationWire> {
		const discovery = discoverPyGhidraWorker(ghidraHome, pythonPath);
		if (!discovery.available) {
			throw new Error(discovery.reason);
		}
		const decompiler = this.getPyGhidra(discovery.configuration);
		const status = await decompiler.status();
		const targetOpenMs = await decompiler.prepareTarget(sessionId, this.session(sessionId).targetPath, contentHash);
		return {
			backendId: status.backendId,
			backendVersion: status.backendVersion,
			processGeneration: status.processGeneration,
			spawnMs: status.spawnMs,
			handshakeMs: status.handshakeMs,
			targetOpenMs,
		};
	}

	async cancelDecompile(operationId: string): Promise<void> {
		this.decompilations.get(operationId)?.source.cancel();
	}

	async closeImage(sessionId: AnalysisSessionId): Promise<void> {
		for (const operation of this.decompilations.values()) {
			if (operation.sessionId === sessionId) {
				operation.source.cancel();
			}
		}
		try {
			await this.pyGhidra.value?.closeTarget(sessionId);
		} catch {
			await this.resetPyGhidra();
		}
		const session = this.sessions.get(sessionId);
		if (session) {
			this.sessions.delete(sessionId);
			session.dispose();
		}
	}

	private session(sessionId: AnalysisSessionId): DelverAnalysisSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`No analysis session ${sessionId}`);
		}
		return session;
	}

	private getPyGhidra(configuration: { readonly ghidraHome: string; readonly pythonPath: string; readonly workerScriptPath: string }): PyGhidraDecompiler {
		const key = `${configuration.pythonPath}\0${configuration.ghidraHome}\0${configuration.workerScriptPath}`;
		if (!this.pyGhidra.value || this.pyGhidraKey !== key) {
			this.retirePyGhidra();
			this.pyGhidra.value = new PyGhidraDecompiler(configuration, this.pyGhidraCacheRoot);
			this.pyGhidraKey = key;
		}
		return this.pyGhidra.value;
	}

	/**
	 * Retires the current worker without killing it.
	 *
	 * Assigning over the {@link MutableDisposable} would dispose the old worker,
	 * and disposal terminates the process outright. Ghidra only releases the lock
	 * inside the cached project when it exits on its own, so a reconfiguration
	 * that kills it poisons that project for every later open of the same
	 * content — the cache is keyed by content hash and survives the restart.
	 */
	private retirePyGhidra(): void {
		const previous = this.pyGhidra.clearAndLeak();
		this.pyGhidraKey = undefined;
		if (previous) {
			this.retiring.add(previous);
			void this.shutdownRetired(previous);
		}
	}

	private async shutdownRetired(decompiler: PyGhidraDecompiler): Promise<void> {
		try {
			await decompiler.shutdown();
		} catch {
			// The worker is on its way out and no caller is waiting on it; the
			// shutdown path escalates to a signal on its own if it has to.
		} finally {
			this.retiring.delete(decompiler);
			decompiler.dispose();
		}
	}

	private async resetPyGhidra(): Promise<void> {
		const decompiler = this.pyGhidra.value;
		if (decompiler) {
			await decompiler.shutdown();
		}
		if (this.pyGhidra.value === decompiler) {
			this.pyGhidra.clear();
			this.pyGhidraKey = undefined;
		}
	}

	private closeAll(): void {
		for (const operation of this.decompilations.values()) {
			operation.source.cancel();
		}
		for (const session of this.sessions.values()) {
			session.dispose();
		}
		this.sessions.clear();
		// A worker still draining its graceful shutdown is no longer owned by the
		// MutableDisposable; the service going away is the one point where waiting
		// for it is no longer an option.
		for (const decompiler of this.retiring) {
			decompiler.dispose();
		}
		this.retiring.clear();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertSafeDecompilerCacheRoot(root: string): void {
	const normalized = normalize(root);
	if (!isAbsolute(normalized) || basename(normalized) !== 'decompiler-cache' || basename(dirname(normalized)) !== 'delver') {
		throw new Error(`Refusing to clear an unexpected decompiler cache path: ${root}`);
	}
}

async function measureDecompilerCache(root: string): Promise<IDelverDecompilerCacheInfoWire> {
	let projectCount = 0;
	let fileCount = 0;
	let byteLength = 0;
	const directories = [root];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) {
			break;
		}
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				continue;
			}
			throw error;
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(entryPath);
			} else if (entry.isFile()) {
				const stat = await fs.stat(entryPath);
				fileCount++;
				byteLength += stat.size;
				if (entry.name.toLowerCase().endsWith('.gpr')) {
					projectCount++;
				}
			}
		}
	}
	return { path: root, projectCount, fileCount, byteLength };
}
