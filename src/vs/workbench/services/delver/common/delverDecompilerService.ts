/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { stringHash } from '../../../../base/common/hash.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AnalysisSessionId, DelverDecompilerStatusWire, IDelverAnalysisService, IDelverBackendAnalysisWire, IDelverBackendFunctionsWire, IDelverDecompilationTimingsWire, IDelverDecompilerCacheInfoWire } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IDelverProjectSnapshot } from '../../../../platform/delver/common/delverProjectStoreService.js';
import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { decodeGhidraDecompilerOutput } from './ghidraDecompilerProtocol.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';
import { IDelverProjectService } from './delverProjectService.js';
import { IDelverSessionService } from './delverSessionService.js';

export const IDelverDecompilerService = createDecorator<IDelverDecompilerService>('delverDecompilerService');
export const DELVER_GHIDRA_HOME_SETTING = 'delver.decompiler.ghidraHome';
export const DELVER_DECOMPILER_PYTHON_PATH_SETTING = 'delver.decompiler.pythonPath';
export const DELVER_DECOMPILER_BACKEND_SETTING = 'delver.decompiler.backend';

const GHIDRA_PINNED_VERSION = '12.1';
const MAX_CACHED_FUNCTIONS = 128;

/**
 * Accepted declarations of one kind that may be sent with a decompilation.
 *
 * Must stay equal to `MAX_SEMANTIC_DECLARATIONS` in
 * `scripts/ghidra/delver_decompiler_worker.py`, which is the bound that actually
 * refuses. Duplicated rather than derived because the worker is a separate
 * process in another language; checked on this side so the refusal is local and
 * says what to do about it, instead of arriving as `invalid_params` after the
 * whole snapshot has been serialized and written to the pipe.
 */
const MAX_SEMANTIC_DECLARATIONS = 10_000;

/**
 * Accepted composites that may be sent with a decompilation.
 *
 * Must stay equal to `MAX_SEMANTIC_COMPOSITES` in the worker, for the same
 * reason as the declaration bound above: the refusal that matters is the local
 * one, because it happens before the snapshot is serialized and it can say what
 * to do about it.
 */
const MAX_SEMANTIC_COMPOSITES = 1_000;

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

/** One accepted authored declaration that can affect decompiler output. */
export interface IDecompilationSemanticDeclaration {
	/** Canonical image-relative address. */
	readonly rva: string;
	readonly declaration: string;
}

/** One field of an authored composite, at an explicit offset. */
export interface IDecompilationSemanticField {
	readonly offset: number;
	readonly name: string;
	/** Type declaration, resolved against the program's own type manager. */
	readonly type: string;
}

/**
 * What a composite lays out.
 *
 * A struct gives every field a distinct offset; a union overlays them all at the
 * start. The distinction is the analyst's claim about the bytes, so it travels
 * with the layout rather than being inferred from whether the offsets happen to
 * collide.
 */
export type DelverCompositeKind = 'struct' | 'union';

/**
 * One authored composite type, which belongs to the image rather than to an
 * address.
 *
 * Offsets are explicit and the size includes trailing padding, because a real
 * binary's layout is something the analyst knows and the backend must not
 * re-pack into something tidier and wrong. A union's fields all sit at offset 0
 * — that is what makes it a union — and the offset is still carried and still
 * required to be 0, so a layout that means something else is refused rather
 * than quietly flattened.
 */
export interface IDecompilationSemanticComposite {
	readonly name: string;
	readonly kind: DelverCompositeKind;
	readonly size: number;
	readonly fields: readonly IDecompilationSemanticField[];
}

/**
 * Complete accepted semantic input used for one decompilation.
 *
 * This first version is deliberately content-wide. It may invalidate more
 * functions than necessary, but can never reuse pseudocode produced against a
 * different accepted type model. A later dependency graph can narrow the
 * arrays without changing the durable result envelope.
 */
export interface IDecompilationSemanticDependencies {
	readonly schemaVersion: 2;
	/** Applied before the two arrays below, which may reference them by name. */
	readonly composites: readonly IDecompilationSemanticComposite[];
	readonly dataTypes: readonly IDecompilationSemanticDeclaration[];
	readonly functionPrototypes: readonly IDecompilationSemanticDeclaration[];
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
	readonly semanticDependencies?: IDecompilationSemanticDependencies;
	/**
	 * True when accepted semantics existed but this backend could not apply them.
	 *
	 * The C below is real and correct for the bytes; it simply does not reflect
	 * the analyst's accepted types. Saying so is the whole point — silently
	 * returning type-free pseudocode after a type was accepted would be a
	 * confident answer to a question that was not asked.
	 */
	readonly semanticsIgnored?: boolean;
}

/** Everything a backend needs to identify one function in the active image. */
export interface IDecompileFunctionRequest {
	readonly sessionId?: AnalysisSessionId;
	readonly targetPath?: string;
	readonly contentHash: string;
	readonly functionRva: bigint;
	/** Internal accepted semantic snapshot. Callers normally leave this absent. */
	readonly semanticDependencies?: IDecompilationSemanticDependencies;
}

export type DelverDecompilerStatus =
	| { readonly state: 'ready'; readonly available: true; readonly backendId: string; readonly backendVersion?: string; readonly adapterVersion?: string; readonly label: string; readonly processGeneration?: number; readonly spawnMs?: number; readonly handshakeMs?: number }
	| { readonly state: 'unconfigured' | 'starting' | 'failed' | 'disabled'; readonly available: false; readonly reason: string; readonly diagnostic?: string };

/** Backend-neutral seam shared by the Ghidra adapter and future decompilers. */
export interface IDelverDecompilerBackend {
	readonly status: DelverDecompilerStatus;
	/**
	 * Whether this backend can apply accepted data types and prototypes.
	 *
	 * Absent means yes. A backend that answers `false` is not refused — it is
	 * asked for pseudocode built against no accepted semantics at all, and the
	 * result is attributed to that empty snapshot rather than to the one the
	 * caller asked for.
	 */
	readonly appliesSemantics?: boolean;
	readonly onDidChangeStatus?: Event<DelverDecompilerStatus>;
	prepare?(): Promise<DelverDecompilerStatus>;
	restart?(): Promise<DelverDecompilerStatus>;
	cacheInfo?(): Promise<IDelverDecompilerCacheInfoWire>;
	clearCache?(): Promise<IDelverDecompilerCacheInfoWire>;
	prepareTarget?(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<void>;
	decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction>;
	listBackendFunctions?(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<IDelverBackendFunctionsWire | undefined>;
	analyzeBackendTarget?(request: Omit<IDecompileFunctionRequest, 'functionRva'>, token: CancellationToken): Promise<IDelverBackendAnalysisWire | undefined>;
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
	/**
	 * Every function the configured backend recovered, for the cross-backend
	 * handshake (ADR 0017).
	 *
	 * `undefined` when the backend cannot enumerate — the absence of an answer,
	 * never an empty set. Never cached: the whole point is to see what the
	 * backend believes right now.
	 */
	listBackendFunctions(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<IDelverBackendFunctionsWire | undefined>;
	/**
	 * Finishes the backend's analysis of one target, so its whole function set
	 * means something. Minutes on a large image, and cancellable.
	 */
	analyzeBackendTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>, token: CancellationToken): Promise<IDelverBackendAnalysisWire | undefined>;
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
			? { state: 'starting', available: false, reason: localize('delverDecompilerStarting', "Starting {0}…", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') }
			: { state: 'unconfigured', available: false, reason: localize('delverDecompilerUnavailable', "Configure a Ghidra {0} installation directory in the Delver settings.", GHIDRA_PINNED_VERSION) });
	}

	async prepare(): Promise<DelverDecompilerStatus> {
		if (this.backendSelection === 'disabled' || !this.ghidraHome) {
			return this.status;
		}
		this.setStatus({ state: 'starting', available: false, reason: localize('delverDecompilerStarting', "Starting {0}…", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') });
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
		this.setStatus({ state: 'starting', available: false, reason: localize('delverDecompilerRestarting', "Restarting {0}…", this.backendSelection === 'headless' ? 'Ghidra Headless' : 'PyGhidra') });
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

	async analyzeBackendTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>, token: CancellationToken): Promise<IDelverBackendAnalysisWire | undefined> {
		const ghidraHome = this.ghidraHome;
		const status = this.status.state === 'ready' ? this.status : await this.prepare();
		if (!ghidraHome || status.state !== 'ready') {
			throw new DelverDecompilerUnavailableError(status.available ? '' : formatStatusError(status));
		}
		if (!request.sessionId || !request.targetPath) {
			throw new DelverDecompilerUnavailableError(localize('delverDecompilerAnalyzeTargetRequired', "Attach the matching target before asking the decompiler backend to analyze it."));
		}
		const operationId = generateUuid();
		const cancellationListener = token.onCancellationRequested(() => {
			void this.analysisService.cancelDecompile(operationId);
		});
		try {
			return await this.analysisService.analyzeBackendTarget(
				request.sessionId,
				request.contentHash,
				ghidraHome,
				this.pythonPath,
				this.backendSelection === 'headless' ? 'headless' : 'pyghidra',
				operationId,
			);
		} finally {
			cancellationListener.dispose();
		}
	}

	async listBackendFunctions(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<IDelverBackendFunctionsWire | undefined> {
		const ghidraHome = this.ghidraHome;
		const status = this.status.state === 'ready' ? this.status : await this.prepare();
		if (!ghidraHome || status.state !== 'ready') {
			throw new DelverDecompilerUnavailableError(status.available ? '' : formatStatusError(status));
		}
		if (!request.sessionId || !request.targetPath) {
			throw new DelverDecompilerUnavailableError(localize('delverDecompilerHandshakeTargetRequired', "Attach the matching target to compare Delver's functions against the decompiler backend's."));
		}
		return this.analysisService.listBackendFunctions(
			request.sessionId,
			request.contentHash,
			ghidraHome,
			this.pythonPath,
			this.backendSelection === 'headless' ? 'headless' : 'pyghidra',
		);
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
		const semanticDependencies = request.semanticDependencies ?? emptySemanticDependencies();
		// Refused here rather than truncated, and refused before the request is
		// built rather than by the worker after 20 MB has crossed the pipe. A
		// truncated snapshot would decompile against *some* of the analyst's
		// accepted types and present the result as though all of them applied,
		// which is the one outcome worse than not answering.
		if (semanticDependencies.dataTypes.length > MAX_SEMANTIC_DECLARATIONS
			|| semanticDependencies.functionPrototypes.length > MAX_SEMANTIC_DECLARATIONS
			|| semanticDependencies.composites.length > MAX_SEMANTIC_COMPOSITES) {
			throw new DelverDecompilerUnavailableError(localize('delverDecompilerSemanticLimit', "This project has more accepted data types, function prototypes, or structures than the decompiler backend accepts. Retire some before decompiling."));
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
				semanticDependencies,
			);
			const serialized = attachSemanticDependencies(result.serialized, semanticDependencies);
			const decoded = decodeGhidraDecompilerOutput(serialized, request.functionRva, result.backendId);
			this.logService?.info(`[Delver decompiler] ${result.backendId} ${result.backendVersion}, generation ${result.processGeneration}, RVA 0x${request.functionRva.toString(16)}: spawn=${result.timings.spawnMs}ms handshake=${result.timings.handshakeMs}ms open=${result.timings.targetOpenMs}ms recovery=${result.timings.functionRecoveryMs}ms decompile=${result.timings.decompilationMs}ms serialize=${result.timings.serializationMs}ms`);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			await this.projectService?.recordDecompilation(request.contentHash, {
				backendId: result.backendId,
				backendVersion: result.backendVersion,
				functionRva: `0x${request.functionRva.toString(16)}`,
				serialized,
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
			// A cancellation raised in the shared process arrives here as a plain
			// `Error` carrying the canonical name and message, never as an instance
			// (ADR 0001, "Scope"). Testing the shape is what keeps Escape from being
			// reported as a dead backend.
			if (!isCancellationError(error)) {
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

	/**
	 * Headless runs a one-shot script with no route for accepted declarations.
	 *
	 * It used to refuse such a request outright, which turned one accepted type
	 * into a total loss of pseudocode: the saved text no longer matched the
	 * snapshot and nothing would produce new text. Declaring the limitation
	 * instead lets the service ask for what this backend *can* answer.
	 */
	get appliesSemantics(): boolean {
		return this.backendSelection !== 'headless';
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
		private readonly semanticDependencies?: (contentHash: string) => IDecompilationSemanticDependencies,
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

	listBackendFunctions(request: Omit<IDecompileFunctionRequest, 'functionRva'>): Promise<IDelverBackendFunctionsWire | undefined> {
		// A backend that cannot enumerate answers `undefined`, which reads as
		// "no comparison is available" rather than "the sets agree" (ADR 0017).
		return this.backend.listBackendFunctions?.(request) ?? Promise.resolve(undefined);
	}

	analyzeBackendTarget(request: Omit<IDecompileFunctionRequest, 'functionRva'>, token: CancellationToken): Promise<IDelverBackendAnalysisWire | undefined> {
		return this.backend.analyzeBackendTarget?.(request, token) ?? Promise.resolve(undefined);
	}

	decompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		const { semanticsDropped, ...resolved } = this.withSemanticDependencies(request);
		const key = decompilationKey(resolved.contentHash, resolved.functionRva, resolved.semanticDependencies);
		// Marked on the way out rather than stored: the cached and saved text is
		// genuinely the answer for the empty snapshot it is keyed under, and it
		// stops being an unapplied-types answer the moment a backend that can
		// apply them is configured. The flag belongs to the request, not the C.
		const mark = (result: IDecompiledFunction): IDecompiledFunction =>
			semanticsDropped ? { ...result, semanticsIgnored: true } : result;
		const cached = this.cache.get(key);
		if (cached) {
			// Refresh insertion order so frequently revisited functions survive the
			// bounded cache. The result is immutable, so sharing it between editor
			// panes cannot let one pane alter another pane's pseudocode.
			this.cache.delete(key);
			this.cache.set(key, cached);
			return Promise.resolve(mark(cached));
		}
		const saved = this.loadSavedResult(resolved);
		if (saved) {
			this.cacheResult(key, saved);
			return Promise.resolve(mark(saved));
		}
		const pending = this.pending.get(key);
		if (pending) {
			return pending.then(mark);
		}
		return this.decompileAndCache(key, resolved, token, false, semanticsDropped);
	}

	redecompileFunction(request: IDecompileFunctionRequest, token: CancellationToken): Promise<IDecompiledFunction> {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const { semanticsDropped, ...resolved } = this.withSemanticDependencies(request);
		return this.decompileAndCache(
			decompilationKey(resolved.contentHash, resolved.functionRva, resolved.semanticDependencies),
			resolved, token, true, semanticsDropped);
	}

	savedResultDiagnostic(request: Pick<IDecompileFunctionRequest, 'contentHash' | 'functionRva'>): string | undefined {
		const resolved = this.withSemanticDependencies(request);
		return this.savedDiagnostics.get(decompilationKey(resolved.contentHash, resolved.functionRva, resolved.semanticDependencies));
	}

	private decompileAndCache(key: string, request: IDecompileFunctionRequest, token: CancellationToken, refresh = false, semanticsDropped = false): Promise<IDecompiledFunction> {
		// A refresh must never be answered by an in-flight request: coalescing is a
		// cache, and the caller asked precisely because the cached answer is wrong.
		// It runs alongside its predecessor instead, and only the newest operation
		// for a key is the one the map hands to later callers.
		const existing = refresh ? undefined : this.pending.get(key);
		if (existing) {
			return existing;
		}
		const operation = this.runBackend(key, request, token, refresh, semanticsDropped);
		this.pending.set(key, operation);
		const settled = () => {
			if (this.pending.get(key) === operation) {
				this.pending.delete(key);
			}
		};
		void operation.then(settled, settled);
		return operation;
	}

	private async runBackend(key: string, request: IDecompileFunctionRequest, token: CancellationToken, refresh: boolean, semanticsDropped: boolean): Promise<IDecompiledFunction> {
		const previous = this.cache.get(key);
		try {
			const backendResult = await this.backend.decompileFunction(request, token);
			const attributed = backendResult.semanticDependencies || hasSemanticDependencies(request.semanticDependencies!)
				? { ...backendResult, semanticDependencies: request.semanticDependencies }
				: backendResult;
			if (attributed.timings) {
				this.latestLivePerformance = attributed;
			}
			// Cached without the flag, and marked on the way out — the text is
			// genuinely the answer for the empty snapshot it is keyed under, and
			// it stops being an unapplied-types answer the moment the analyst
			// retires the last accepted type. Storing the flag made that cache
			// entry keep warning about types that no longer exist.
			this.cacheResult(key, attributed);
			return semanticsDropped ? { ...attributed, semanticsIgnored: true } : attributed;
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

	/**
	 * Drops every cached body for one image, after its facts were re-derived.
	 *
	 * The cache key is content hash, function RVA, and a digest of the accepted
	 * *types* — deliberately, because a type change is what usually changes the
	 * C. A correction changes something the key cannot see: where the function
	 * is, or whether it exists at all. Left alone, the pane and
	 * `delver_decompile` keep answering for an RVA whose function was just
	 * undefined, with a body derived from bounds that no longer exist.
	 *
	 * Content-wide rather than per-function, for the same reason the semantic
	 * snapshot is: a re-derivation moves call targets and block boundaries
	 * across the image, so "which functions changed" is not a question the key
	 * can answer.
	 */
	invalidateDerivedFacts(contentHash: string): void {
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(`${contentHash}:`)) {
				this.cache.delete(key);
			}
		}
		for (const key of [...this.savedDiagnostics.keys()]) {
			if (key.startsWith(`${contentHash}:`)) {
				this.savedDiagnostics.delete(key);
			}
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
		const key = decompilationKey(request.contentHash, request.functionRva, request.semanticDependencies!);
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
				const decoded = decodeGhidraDecompilerOutput(candidate.serialized, request.functionRva, candidate.backendId);
				if (!sameSemanticDependencies(decoded.semanticDependencies, request.semanticDependencies!)) {
					this.savedDiagnostics.set(key, localize('delverSavedDecompilerStaleSemantics', "Saved pseudocode at {0} was ignored because accepted type interpretation changed after it was produced.", canonicalRva(request.functionRva)));
					continue;
				}
				return {
					...decoded,
					backendVersion: candidate.backendVersion,
					provenance: 'saved',
				};
			} catch (error) {
				this.savedDiagnostics.set(key, localize('delverSavedDecompilerInvalid', "Saved pseudocode at {0} from {1} {2} was ignored: {3}", canonicalRva(request.functionRva), candidate.backendId, candidate.backendVersion, errorMessage(error)));
			}
		}
		return undefined;
	}

	/**
	 * Resolves the snapshot a request will actually be answered against.
	 *
	 * Not always the accepted one. A backend that cannot apply declarations is
	 * answering against *no* accepted semantics, so that is the snapshot the
	 * request carries, the cache is keyed on, and the saved result records. That
	 * attribution is what makes the whole thing behave:
	 *
	 * - pseudocode saved before any type was accepted still matches, so accepting
	 *   a type on such a backend no longer empties the pane;
	 * - the cache stops missing on every call, because the effective snapshot is
	 *   stable rather than one the backend will never satisfy;
	 * - and installing a backend that *can* apply them changes the effective
	 *   snapshot back, which re-decompiles exactly as it should.
	 *
	 * `semanticsDropped` is carried separately so the result can say the accepted
	 * types were not applied. Answering without saying so would be worse than
	 * refusing, which is what this used to do.
	 */
	private withSemanticDependencies<T extends Pick<IDecompileFunctionRequest, 'contentHash' | 'functionRva'> & { readonly semanticDependencies?: IDecompilationSemanticDependencies }>(request: T): T & { readonly semanticDependencies: IDecompilationSemanticDependencies; readonly semanticsDropped: boolean } {
		const accepted = request.semanticDependencies ?? this.semanticDependencies?.(request.contentHash) ?? emptySemanticDependencies();
		const dropped = this.backend.appliesSemantics === false && hasSemanticDependencies(accepted);
		return {
			...request,
			semanticDependencies: dropped ? emptySemanticDependencies() : accepted,
			semanticsDropped: dropped,
		};
	}
}

class DefaultDelverDecompilerService extends DelverDecompilerService {
	constructor(
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
		@IConfigurationService configurationService: IConfigurationService,
		@IDelverProjectService projectService: IDelverProjectService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverInterpretationService interpretationService: IDelverInterpretationService,
		@ILogService logService: ILogService,
	) {
		super(
			new SharedProcessDecompilerBackend(analysisService, configurationService, projectService, sessionService, logService),
			contentHash => projectService.projectSnapshot(contentHash),
			contentHash => semanticDependenciesFor(interpretationService, contentHash),
		);
		// A re-derivation is the one event that changes the C without
		// changing anything in the cache key, so nothing but this listener
		// can evict.
		this.rederived = sessionService.onDidRederiveFacts(session => this.invalidateDerivedFacts(session.contentHash));
	}

	private readonly rederived: IDisposable;

	dispose(): void {
		this.rederived.dispose();
	}
}

/**
 * Cache key for one function under one accepted type model.
 *
 * The snapshot is folded to a digest rather than spelled out. Inlining it put a
 * copy of every accepted declaration — each bounded at 2 KB — into all 128 cache
 * keys, and re-serialized the whole set on every lookup, which is the hot path
 * every pseudocode load takes. The digest is over the same canonical JSON, so
 * two snapshots collide in the key exactly when they are equal; `total` is
 * included so a length change cannot be hidden by a hash collision alone.
 */
function decompilationKey(contentHash: string, functionRva: bigint, semanticDependencies: IDecompilationSemanticDependencies): string {
	return `${contentHash}:${functionRva.toString(16)}:${semanticDigest(semanticDependencies)}`;
}

function semanticDigest(semanticDependencies: IDecompilationSemanticDependencies): string {
	if (!hasSemanticDependencies(semanticDependencies)) {
		return '0';
	}
	const total = semanticDependencies.composites.length + semanticDependencies.dataTypes.length + semanticDependencies.functionPrototypes.length;
	return `${total}.${(stringHash(JSON.stringify(semanticDependencies), 0) >>> 0).toString(16)}`;
}

function emptySemanticDependencies(): IDecompilationSemanticDependencies {
	return { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] };
}

/**
 * Builds the accepted semantic snapshot for one image.
 *
 * Exported for tests: the ordering it produces is a contract with the worker
 * rather than an implementation detail, and it is not otherwise observable
 * without a live backend.
 */
export function semanticDependenciesFor(interpretationService: IDelverInterpretationService, contentHash: string): IDecompilationSemanticDependencies {
	const rvas = new Set<bigint>();
	const typeNames = new Set<string>();
	for (const edit of interpretationService.logFor(contentHash)) {
		if (edit.anchor.kind === 'type') {
			if (edit.op === EditOp.CompositeType) {
				typeNames.add(edit.anchor.name);
			}
		} else if (edit.op === EditOp.DataType || edit.op === EditOp.FunctionPrototype) {
			rvas.add(edit.anchor.rva);
		}
	}
	// Composites are collected first and sorted by name, matching the order the
	// worker requires. It defines them before parsing anything else, so a
	// declaration at an address can name a struct this same snapshot introduced.
	const composites: IDecompilationSemanticComposite[] = [];
	for (const name of [...typeNames].sort()) {
		const layout = interpretationService.at({ kind: 'type', contentHash, name })?.compositeType;
		const parsed = layout === undefined ? undefined : parseCompositeLayout(name, layout);
		if (parsed) {
			composites.push(parsed);
		}
	}
	const dataTypes: IDecompilationSemanticDeclaration[] = [];
	const functionPrototypes: IDecompilationSemanticDeclaration[] = [];
	for (const rva of [...rvas].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
		const current = interpretationService.at({ kind: 'image', contentHash, rva });
		if (current?.dataType) {
			dataTypes.push({ rva: canonicalRva(rva), declaration: current.dataType });
		}
		if (current?.functionPrototype) {
			functionPrototypes.push({ rva: canonicalRva(rva), declaration: current.functionPrototype });
		}
	}
	return { schemaVersion: 2, composites, dataTypes, functionPrototypes };
}

/**
 * Reads one stored composite layout back into the shape the worker expects.
 *
 * A layout that no longer parses is dropped rather than sent. It was validated
 * when it was authored, so this only fires on a project edited by hand or
 * written by a newer version — and in both cases the honest move is to decompile
 * without it rather than to hand the worker something it will refuse, which
 * would make every function in the image unreadable over one bad row.
 */
function parseCompositeLayout(name: string, layout: string): IDecompilationSemanticComposite | undefined {
	try {
		const parsed = JSON.parse(layout) as Omit<IDecompilationSemanticComposite, 'name'>;
		if ((parsed.kind !== 'struct' && parsed.kind !== 'union') || typeof parsed.size !== 'number' || !Array.isArray(parsed.fields)) {
			return undefined;
		}
		return {
			name,
			kind: parsed.kind,
			size: parsed.size,
			fields: parsed.fields.map(field => ({ offset: field.offset, name: field.name, type: field.type })),
		};
	} catch {
		return undefined;
	}
}

function sameSemanticDependencies(left: IDecompilationSemanticDependencies | undefined, right: IDecompilationSemanticDependencies): boolean {
	return JSON.stringify(left ?? emptySemanticDependencies()) === JSON.stringify(right);
}

function hasSemanticDependencies(value: IDecompilationSemanticDependencies): boolean {
	return value.composites.length > 0 || value.dataTypes.length > 0 || value.functionPrototypes.length > 0;
}

/**
 * Records the snapshot a decompilation was produced against, in its own result.
 *
 * Omitted when the snapshot is empty. The decoder already reads an absent field
 * as the empty snapshot and `sameSemanticDependencies` already treats the two as
 * equal, so writing it out would add roughly seventy bytes to every saved
 * function in a portable project to say nothing at all — and a project with no
 * authored types is the common case, not the edge one.
 */
function attachSemanticDependencies(serialized: string, semanticDependencies: IDecompilationSemanticDependencies): string {
	if (!hasSemanticDependencies(semanticDependencies)) {
		return serialized;
	}
	const value: unknown = JSON.parse(serialized);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return serialized;
	}
	return JSON.stringify({ ...value, semanticDependencies });
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
