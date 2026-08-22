/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AnalysisSessionId, DelverDecompilerStatusWire, IDelverAnalysisService, IDelverDecompilationTimingsWire, IDelverDecompilerCacheInfoWire } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IDelverProjectSnapshot } from '../../../../platform/delver/common/delverProjectStoreService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { decodeGhidraDecompilerOutput } from './ghidraDecompilerProtocol.js';
import { IDelverProjectService } from './delverProjectService.js';
import { IDelverSessionService } from './delverSessionService.js';

export const IDelverDecompilerService = createDecorator<IDelverDecompilerService>('delverDecompilerService');
export const DELVER_GHIDRA_HOME_SETTING = 'delver.decompiler.ghidraHome';
export const DELVER_DECOMPILER_PYTHON_PATH_SETTING = 'delver.decompiler.pythonPath';
export const DELVER_DECOMPILER_BACKEND_SETTING = 'delver.decompiler.backend';

const GHIDRA_PINNED_VERSION = '12.1';
const MAX_CACHED_FUNCTIONS = 128;

/** One half-open image-relative address range represented by a pseudocode line. */
export interface IDecompiledAddressRange {
	readonly startRva: bigint;
	readonly endRva: bigint;
}

/**
 * Address provenance for one one-based pseudocode line.
 *
 * A source line may represent discontiguous instructions after control-flow
 * structuring, so the mapping deliberately carries multiple ranges.
 */
export interface IDecompiledLineMapping {
	readonly line: number;
	readonly ranges: readonly IDecompiledAddressRange[];
}

/** Variable recovered by the backend without imposing Delver's future type system. */
export interface IDecompiledVariable {
	readonly name: string;
	readonly typeName?: string;
	readonly storage?: string;
	readonly declarationLine?: number;
}

/** Stable output consumed by the pseudocode editor and, later, AI tooling. */
export interface IDecompiledFunction {
	readonly backendId: string;
	readonly backendVersion?: string;
	readonly adapterVersion?: string;
	readonly processGeneration?: number;
	readonly timings?: IDelverDecompilationTimingsWire;
	readonly provenance?: 'live' | 'saved';
	readonly functionRva: bigint;
	readonly text: string;
	readonly lineMappings: readonly IDecompiledLineMapping[];
	readonly variables: readonly IDecompiledVariable[];
}

/** Everything a backend needs to identify one function in the active image. */
export interface IDecompileFunctionRequest {
	readonly sessionId?: AnalysisSessionId;
	readonly targetPath?: string;
	readonly contentHash: string;
	readonly functionRva: bigint;
}

export type DelverDecompilerStatus =
	| { readonly state: 'ready'; readonly available: true; readonly backendId: string; readonly backendVersion?: string; readonly adapterVersion?: string; readonly label: string; readonly processGeneration?: number; readonly spawnMs?: number; readonly handshakeMs?: number }
	| { readonly state: 'unconfigured' | 'starting' | 'failed' | 'disabled'; readonly available: false; readonly reason: string; readonly diagnostic?: string };

/** Backend-neutral seam shared by the Ghidra adapter and future decompilers. */
export interface IDelverDecompilerBackend {
	readonly status: DelverDecompilerStatus;
	readonly onDidChangeStatus?: Event<DelverDecompilerStatus>;
	prepare?(): Promise<DelverDecompilerStatus>;
	restart?(): Promise<DelverDecompilerStatus>;
	cacheInfo?(): Promise<IDelverDecompilerCacheInfoWire>;
	clearCache?(): Promise<IDelverDecompilerCacheInfoWire>;
	prepareTarget?(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<void>;
	decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction>;
}

/** Decompiles functions through the configured replaceable backend. */
export interface IDelverDecompilerService {
	readonly _serviceBrand: undefined;
	readonly status: DelverDecompilerStatus;
	readonly onDidChangeStatus: Event<DelverDecompilerStatus>;
	readonly latestPerformance: IDecompiledFunction | undefined;
	prepare(): Promise<DelverDecompilerStatus>;
	restart(): Promise<DelverDecompilerStatus>;
	cacheInfo(): Promise<IDelverDecompilerCacheInfoWire>;
	clearCache(): Promise<IDelverDecompilerCacheInfoWire>;
	prepareTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<void>;
	decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction>;
	/** Explicitly bypasses portable and memory caches, replacing them only after a successful backend result. */
	redecompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction>;
	/** Diagnostic for a saved row rejected during the most recent exact lookup. */
	savedResultDiagnostic(request: Pick<IDecompileFunctionRequest, 'contentHash' | 'functionRva'>): string | undefined;
}

/** Raised when pseudocode is requested before a backend is available. */
export class DelverDecompilerUnavailableError extends Error {
	override readonly name = 'DelverDecompilerUnavailableError';
}

export class SharedProcessDecompilerBackend implements IDelverDecompilerBackend {
	private readonly statusEmitter = new Emitter<DelverDecompilerStatus>();
	readonly onDidChangeStatus = this.statusEmitter.event;
	private currentStatus: DelverDecompilerStatus | undefined;
	private currentStatusBackend: 'pyghidra' | 'headless' | 'disabled' | undefined;

	constructor(
		private readonly analysisService: IDelverAnalysisService,
		private readonly configurationService: IConfigurationService,
		private readonly projectService?: IDelverProjectService,
		private readonly sessionService?: IDelverSessionService,
		private readonly logService?: ILogService,
	) { }

	get status(): DelverDecompilerStatus {
		if (this.backendSelection === 'disabled') {
			return { state: 'disabled', available: false, reason: localize('delverDecompilerDisabled', "The decompiler is disabled in Delver settings.") };
		}
		return (this.currentStatusBackend === this.backendSelection ? this.currentStatus : undefined) ?? (this.ghidraHome
			? { state: 'starting', available: false, reason: localize('delverDecompilerStarting', "Starting {0}â€¦", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') }
			: { state: 'unconfigured', available: false, reason: localize('delverDecompilerUnavailable', "Configure a Ghidra {0} installation directory in the Delver settings.", GHIDRA_PINNED_VERSION) });
	}

	async prepare(): Promise<DelverDecompilerStatus> {
		if (this.backendSelection === 'disabled' || !this.ghidraHome) {
			return this.status;
		}
		this.setStatus({ state: 'starting', available: false, reason: localize('delverDecompilerStarting', "Starting {0}â€¦", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') });
		let status: DelverDecompilerStatusWire;
		try {
			status = await this.analysisService.decompilerStatus(this.ghidraHome, this.pythonPath, this.backendSelection);
		} catch (error) {
			const failed: DelverDecompilerStatus = { state: 'failed', available: false, reason: localize('delverDecompilerStatusFailed', "Could not query the decompiler backend."), diagnostic: errorMessage(error) };
			this.setStatus(failed);
			this.logService?.error(`[Delver decompiler] ${formatStatusError(failed)}`);
			return failed;
		}
		const resolved: DelverDecompilerStatus = status.state === 'ready'
			? { ...status, available: true }
			: { ...status, available: false };
		this.setStatus(resolved);
		if (resolved.state === 'ready') {
			this.logService?.info(`[Delver decompiler] ready: ${resolved.backendId} ${resolved.backendVersion} adapter ${resolved.adapterVersion}, generation ${resolved.processGeneration}; spawn=${resolved.spawnMs}ms handshake=${resolved.handshakeMs}ms`);
		} else if (resolved.state === 'failed') {
			this.logService?.error(`[Delver decompiler] ${formatStatusError(resolved)}`);
		}
		return resolved;
	}

	async restart(): Promise<DelverDecompilerStatus> {
		if (this.backendSelection === 'disabled' || !this.ghidraHome) {
			return this.status;
		}
		this.setStatus({ state: 'starting', available: false, reason: localize('delverDecompilerRestarting', "Restarting {0}â€¦", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') });
		try {
			const status = await this.analysisService.restartDecompiler(this.ghidraHome, this.pythonPath, this.backendSelection === 'headless' ? 'headless' : 'pyghidra');
			const resolved: DelverDecompilerStatus = status.state === 'ready'
				? { ...status, available: true }
				: { ...status, available: false };
			this.setStatus(resolved);
			return resolved;
		} catch (error) {
			const failed: DelverDecompilerStatus = { state: 'failed', available: false, reason: localize('delverDecompilerRestartFailed', "Could not restart the decompiler backend."), diagnostic: errorMessage(error) };
			this.setStatus(failed);
			return failed;
		}
	}

	cacheInfo(): Promise<IDelverDecompilerCacheInfoWire> {
		return this.analysisService.decompilerCacheInfo();
	}

	clearCache(): Promise<IDelverDecompilerCacheInfoWire> {
		return this.analysisService.clearDecompilerCache();
	}

	async prepareTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<void> {
		if (this.backendSelection !== 'pyghidra') {
			return;
		}
		const ghidraHome = this.ghidraHome;
		if (!ghidraHome || !request.sessionId || !request.targetPath) {
			return;
		}
		const status = this.status.state === 'ready' ? this.status : await this.prepare();
		if (status.state !== 'ready') {
			throw new DelverDecompilerUnavailableError(formatStatusError(status));
		}
		const prepared = await this.analysisService.prepareDecompilerTarget(request.sessionId, request.contentHash, ghidraHome, this.pythonPath);
		this.logService?.info(`[Delver decompiler] prepared target generation ${prepared.processGeneration}: spawn=${prepared.spawnMs}ms handshake=${prepared.handshakeMs}ms open=${prepared.targetOpenMs}ms`);
	}

	async decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction> {
		const ghidraHome = this.ghidraHome;
		const status = this.status.state === 'ready' ? this.status : await this.prepare();
		if (!ghidraHome || status.state !== 'ready') {
			throw new DelverDecompilerUnavailableError(status.available ? '' : formatStatusError(status));
		}
		if (!request.sessionId || !request.targetPath) {
			throw new DelverDecompilerUnavailableError(localize('delverDecompilerTargetRequired', "Attach the matching target to decompile content that is not saved in this project."));
		}

		const operationId = generateUuid();
		const cancellationListener = token.onCancellationRequested(() => {
			void this.analysisService.cancelDecompile(operationId);
		});
		try {
			const result = await this.analysisService.decompileFunction(
				request.sessionId,
				`0x${request.functionRva.toString(16)}`,
				request.contentHash,
				ghidraHome,
				this.pythonPath,
				operationId,
				this.backendSelection === 'headless' ? 'headless' : 'pyghidra',
			);
			const decoded = decodeGhidraDecompilerOutput(result.serialized, request.functionRva, result.backendId);
			this.logService?.info(`[Delver decompiler] ${result.backendId} ${result.backendVersion}, generation ${result.processGeneration}, RVA 0x${request.functionRva.toString(16)}: spawn=${result.timings.spawnMs}ms handshake=${result.timings.handshakeMs}ms open=${result.timings.targetOpenMs}ms recovery=${result.timings.functionRecoveryMs}ms decompile=${result.timings.decompilationMs}ms serialize=${result.timings.serializationMs}ms`);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			await this.projectService?.recordDecompilation(request.contentHash, {
				backendId: result.backendId,
				backendVersion: result.backendVersion,
				functionRva: `0x${request.functionRva.toString(16)}`,
				serialized: result.serialized,
			});
			if (!this.projectService?.projectPath(request.contentHash)) {
				this.sessionService?.markProjectDirty();
			}
			return {
				...decoded,
				backendVersion: result.backendVersion,
				adapterVersion: result.adapterVersion,
				processGeneration: result.processGeneration,
				timings: result.timings,
				provenance: 'live',
			};
		}
		catch (error) {
			if (!(error instanceof CancellationError)) {
				const diagnostic = errorMessage(error);
				this.setStatus({ state: 'failed', available: false, reason: localize('delverDecompilerFailed', "The selected decompiler backend failed."), diagnostic });
				this.logService?.error(`[Delver decompiler] ${diagnostic}`);
			}
			throw error;
		}
		finally {
			cancellationListener.dispose();
		}
	}

	private get ghidraHome(): string | undefined {
		const configured = this.configurationService.getValue<string>(DELVER_GHIDRA_HOME_SETTING)?.trim();
		return configured || undefined;
	}

	private get pythonPath(): string {
		return this.configurationService.getValue<string>(DELVER_DECOMPILER_PYTHON_PATH_SETTING)?.trim() || 'auto';
	}

	private get backendSelection(): 'pyghidra' | 'headless' | 'disabled' {
		const value = this.configurationService.getValue<string>(DELVER_DECOMPILER_BACKEND_SETTING);
		return value === 'headless' || value === 'disabled' ? value : 'pyghidra';
	}

	private setStatus(status: DelverDecompilerStatus): void {
		this.currentStatus = status;
		this.currentStatusBackend = this.backendSelection;
		this.statusEmitter.fire(status);
	}
}

/** Owns the replaceable backend boundary used by every decompiler consumer. */
export class DelverDecompilerService implements IDelverDecompilerService {
	readonly _serviceBrand: undefined;
	private readonly cache = new Map<string, IDecompiledFunction>();
	private readonly pending = new Map<string, Promise<IDecompiledFunction>>();
	private readonly savedDiagnostics = new Map<string, string>();
	private latestLivePerformance: IDecompiledFunction | undefined;

	constructor(
		private readonly backend: IDelverDecompilerBackend,
		private readonly projectSnapshot?: (contentHash: string) => IDelverProjectSnapshot | undefined,
	) { }

	readonly onDidChangeStatus: Event<DelverDecompilerStatus> = this.backend.onDidChangeStatus ?? Event.None;

	get status(): DelverDecompilerStatus {
		return this.backend.status;
	}

	get latestPerformance(): IDecompiledFunction | undefined {
		return this.latestLivePerformance;
	}

	prepare(): Promise<DelverDecompilerStatus> {
		return this.backend.prepare?.() ?? Promise.resolve(this.backend.status);
	}

	restart(): Promise<DelverDecompilerStatus> {
		return this.backend.restart?.() ?? this.prepare();
	}

	cacheInfo(): Promise<IDelverDecompilerCacheInfoWire> {
		return this.backend.cacheInfo?.() ?? Promise.resolve({ path: '', projectCount: 0, fileCount: 0, byteLength: 0 });
	}

	clearCache(): Promise<IDelverDecompilerCacheInfoWire> {
		return this.backend.clearCache?.() ?? Promise.resolve({ path: '', projectCount: 0, fileCount: 0, byteLength: 0 });
	}

	prepareTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<void> {
		return this.backend.prepareTarget?.(request) ?? Promise.resolve();
	}

	decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const key = decompilationKey(request.contentHash, request.functionRva);
		const cached = this.cache.get(key);
		if (cached) {
			// Refresh insertion order so frequently revisited functions survive the
			// bounded cache. The result is immutable, so sharing it between editor
			// panes cannot let one pane alter another pane's pseudocode.
			this.cache.delete(key);
			this.cache.set(key, cached);
			return Promise.resolve(cached);
		}
		const saved = this.loadSavedResult(request);
		if (saved) {
			this.cacheResult(key, saved);
			return Promise.resolve(saved);
		}
		const pending = this.pending.get(key);
		if (pending) {
			return pending;
		}
		return this.decompileAndCache(key, request, token);
	}

	redecompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		return this.decompileAndCache(decompilationKey(request.contentHash, request.functionRva), request, token, true);
	}

	savedResultDiagnostic(request: Pick<IDecompileFunctionRequest, 'contentHash' | 'functionRva'>): string | undefined {
		return this.savedDiagnostics.get(decompilationKey(request.contentHash, request.functionRva));
	}

	private decompileAndCache(key: string, request: IDecompileFunctionRequest, token: CancellationToken, refresh = false): Promise<IDecompiledFunction> {
		const existing = this.pending.get(key);
		if (existing) {
			return existing;
		}
		const operation = this.runBackend(key, request, token, refresh);
		this.pending.set(key, operation);
		void operation.then(() => this.pending.delete(key), () => this.pending.delete(key));
		return operation;
	}

	private async runBackend(key: string, request: IDecompileFunctionRequest, token: CancellationToken, refresh: boolean): Promise<IDecompiledFunction> {
		const previous = this.cache.get(key);
		try {
			const result = await this.backend.decompileFunction(request, token);
			if (result.timings) {
				this.latestLivePerformance = result;
			}
			this.cacheResult(key, result);
			return result;
		}
		catch (error) {
			// An explicit refresh is atomic from the reader's perspective: failed or
			// cancelled backend work never evicts the last durable result.
			if (refresh && previous) {
				this.cacheResult(key, previous);
			}
			throw error;
		}
	}

	private cacheResult(key: string, result: IDecompiledFunction): void {
		this.cache.delete(key);
		this.cache.set(key, result);
		if (this.cache.size > MAX_CACHED_FUNCTIONS) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
	}

	private loadSavedResult(request: IDecompileFunctionRequest): IDecompiledFunction | undefined {
		const key = decompilationKey(request.contentHash, request.functionRva);
		this.savedDiagnostics.delete(key);
		const snapshot = this.projectSnapshot?.(request.contentHash);
		if (!snapshot || snapshot.metadata.contentHash !== request.contentHash) {
			return undefined;
		}
		if (!snapshotContainsFunction(snapshot.functions, request.functionRva)) {
			this.savedDiagnostics.set(key, localize('delverSavedDecompilerStaleFunction', "Saved pseudocode at {0} was ignored because that function is not present in the selected project revision.", canonicalRva(request.functionRva)));
			return undefined;
		}
		const candidates = (snapshot.decompiledFunctions ?? []).filter(candidate => {
			try {
				return BigInt(candidate.functionRva) === request.functionRva;
			} catch {
				return false;
			}
		});
		for (const candidate of candidates) {
			try {
				if (candidate.functionRva !== canonicalRva(request.functionRva)) {
					throw new Error(localize('delverSavedDecompilerRvaNotCanonical', "function RVA is not canonical"));
				}
				if (!candidate.backendId.trim() || !candidate.backendVersion.trim()) {
					throw new Error(localize('delverSavedDecompilerIdentityMissing', "backend identity is incomplete"));
				}
				return {
					...decodeGhidraDecompilerOutput(candidate.serialized, request.functionRva, candidate.backendId),
					backendVersion: candidate.backendVersion,
					provenance: 'saved',
				};
			} catch (error) {
				this.savedDiagnostics.set(key, localize('delverSavedDecompilerInvalid', "Saved pseudocode at {0} from {1} {2} was ignored: {3}", canonicalRva(request.functionRva), candidate.backendId, candidate.backendVersion, errorMessage(error)));
			}
		}
		return undefined;
	}
}

class DefaultDelverDecompilerService extends DelverDecompilerService {
	constructor(
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDelverProjectService projectService: IDelverProjectService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@ILogService logService: ILogService,
	) {
		super(
			new SharedProcessDecompilerBackend(analysisService, configurationService, projectService, sessionService, logService),
			contentHash => projectService.projectSnapshot(contentHash),
		);
	}
}

function decompilationKey(contentHash: string, functionRva: bigint): string {
	return `${contentHash}:${functionRva.toString(16)}`;
}

function canonicalRva(functionRva: bigint): string {
	return `0x${functionRva.toString(16)}`;
}

function snapshotContainsFunction(serialized: string | undefined, functionRva: bigint): boolean {
	if (!serialized) {
		return true;
	}
	try {
		const value = JSON.parse(serialized) as { readonly functions?: readonly { readonly rva?: string }[] };
		return Array.isArray(value.functions) && value.functions.some(candidate => {
			try {
				return candidate.rva === canonicalRva(functionRva) && BigInt(candidate.rva) === functionRva;
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Returns every range represented by a one-based pseudocode line. */
export function rangesForDecompilerLine(result: IDecompiledFunction, line: number): readonly IDecompiledAddressRange[] {
	return result.lineMappings.filter(mapping => mapping.line === line).flatMap(mapping => mapping.ranges);
}

/** Returns sorted, unique one-based pseudocode lines representing `rva`. */
export function decompilerLinesForRva(result: IDecompiledFunction, rva: bigint): readonly number[] {
	return [...new Set(result.lineMappings
		.filter(mapping => mapping.ranges.some(range => range.startRva <= rva && rva < range.endRva))
		.map(mapping => mapping.line))]
		.sort((left, right) => left - right);
}

registerSingleton(IDelverDecompilerService, DefaultDelverDecompilerService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'delverDecompiler',
	title: localize('delverDecompilerConfigurationTitle', "Delver Decompiler"),
	type: 'object',
	properties: {
		[DELVER_GHIDRA_HOME_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize('delverGhidraHomeDescription', "Installation directory for Ghidra {0}, used by the persistent PyGhidra worker and headless fallback.", GHIDRA_PINNED_VERSION),
		},
		[DELVER_DECOMPILER_PYTHON_PATH_SETTING]: {
			type: 'string',
			default: 'auto',
			scope: ConfigurationScope.MACHINE,
			description: localize('delverDecompilerPythonPathDescription', "Python executable used by Delver's persistent decompiler workers. Use 'auto' to find an installation that already contains PyGhidra."),
		},
		[DELVER_DECOMPILER_BACKEND_SETTING]: {
			type: 'string',
			enum: ['pyghidra', 'headless', 'disabled'],
			default: 'pyghidra',
			scope: ConfigurationScope.MACHINE,
			description: localize('delverDecompilerBackendDescription', "Decompiler backend. Headless mode is intentionally explicit because it starts a slow one-shot analysis."),
		},
	},
});

function formatStatusError(status: Exclude<DelverDecompilerStatus, { readonly state: 'ready' }>): string {
	return status.diagnostic ? `${status.reason}\n${status.diagnostic}` : status.reason;
}
