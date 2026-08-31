/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IBasicBlocksResult, ICallGraphResult, ICallPathsResult, IDataRangeCorrectionWire,
	IFunctionCorrectionWire, IFunctionProfileResult, IFunctionsResult, IGetExportsResult, IGetImageInfoResult, IGetImportsResult, IGlobalAccessesResult, IGlobalsResult, IListingWindowResult, IMomentWire, IOpenImageResult, IRangeWire, IScanStringsResult, ISetCorrectionsResult, IStringsResult, IXrefIndexResult, IXrefsResult } from './protocol.generated.js';
import { TargetConfig } from './target.js';

export const IDelverAnalysisService = createDecorator<IDelverAnalysisService>('delverAnalysisService');

/**
 * Handle for one open analysis session.
 *
 * A session owns a provider process and an analysis server, so it has to be
 * closed explicitly — the renderer holding an editor open is what keeps it
 * alive.
 */
export type AnalysisSessionId = string;

export interface IAnalysisSessionHandle {
	readonly sessionId: AnalysisSessionId;
	readonly image: IOpenImageResult;
}

export type DelverDecompilerBackendState = 'unconfigured' | 'starting' | 'ready' | 'failed' | 'disabled';

export type DelverDecompilerStatusWire =
	| { readonly state: 'ready'; readonly backendId: string; readonly backendVersion: string; readonly adapterVersion: string; readonly label: string; readonly processGeneration: number; readonly spawnMs: number; readonly handshakeMs: number }
	| { readonly state: 'unconfigured' | 'failed' | 'disabled'; readonly reason: string; readonly diagnostic?: string }
	| { readonly state: 'starting'; readonly backendId: string; readonly label: string; readonly reason: string };

export interface IDelverDecompilationTimingsWire {
	readonly spawnMs: number;
	readonly handshakeMs: number;
	readonly targetOpenMs: number;
	readonly functionRecoveryMs: number;
	readonly decompilationMs: number;
	readonly serializationMs: number;
}

export interface IDelverDecompilationWire {
	readonly backendId: string;
	readonly backendVersion: string;
	readonly adapterVersion: string;
	readonly processGeneration: number;
	readonly timings: IDelverDecompilationTimingsWire;
	readonly serialized: string;
}

/** One accepted authored declaration supplied to the decompiler backend. */
export interface IDelverDecompilationSemanticDeclarationWire {
	readonly rva: string;
	readonly declaration: string;
}

/** Complete accepted semantic snapshot used to produce one decompilation. */
/** One field of an authored composite, at an explicit offset. */
export interface IDelverDecompilationSemanticFieldWire {
	readonly offset: number;
	readonly name: string;
	readonly type: string;
}

/** One named constant of an authored enum. */
export interface IDelverDecompilationSemanticEnumMemberWire {
	readonly name: string;
	readonly value: number;
}

/** One authored layout, which belongs to the image, not to an address. */
export interface IDelverDecompilationSemanticLayoutWire {
	readonly name: string;
	readonly kind: 'struct' | 'union';
	readonly size: number;
	readonly fields: readonly IDelverDecompilationSemanticFieldWire[];
}

/** One authored enum. Members are constants, so they carry no offset. */
export interface IDelverDecompilationSemanticEnumWire {
	readonly name: string;
	readonly kind: 'enum';
	readonly size: number;
	readonly members: readonly IDelverDecompilationSemanticEnumMemberWire[];
}

export type IDelverDecompilationSemanticCompositeWire =
	| IDelverDecompilationSemanticLayoutWire
	| IDelverDecompilationSemanticEnumWire;

export interface IDelverDecompilationSemanticsWire {
	readonly schemaVersion: 2;
	/** Defined before the two arrays below, which may reference them by name. */
	readonly composites: readonly IDelverDecompilationSemanticCompositeWire[];
	readonly dataTypes: readonly IDelverDecompilationSemanticDeclarationWire[];
	readonly functionPrototypes: readonly IDelverDecompilationSemanticDeclarationWire[];
}

/** One function a decompiler backend reports having recovered. */
export interface IDelverBackendFunctionWire {
	readonly rva: string;
	readonly endRva: string | undefined;
	readonly name: string;
}

/** A backend's whole function set, for the cross-backend handshake (ADR 0017). */
export interface IDelverBackendFunctionsWire {
	readonly backendId: string;
	readonly backendVersion: string;
	readonly functions: readonly IDelverBackendFunctionWire[];
	/**
	 * Whether the backend had finished analyzing when it answered.
	 *
	 * A backend that recovers functions lazily returns a partial set until its
	 * analysis completes. Comparing a partial set against a complete one reports
	 * the shortfall as disagreement, so a consumer must refuse rather than
	 * present it as a comparison (ADR 0017).
	 */
	readonly analysisComplete: boolean;
}

/**
 * How far a backend has got through one long operation.
 *
 * Carries the `operationId` it belongs to rather than being scoped to a call,
 * because it crosses the shared-process boundary as an event and a renderer may
 * have more than one operation in flight.
 */
export interface IDelverBackendProgressWire {
	readonly operationId: string;
	readonly message?: string;
	/** Completed fraction, 0 to 1, when the backend knows one. */
	readonly fraction?: number;
}

/** Outcome of asking a backend to finish analyzing a target. */
export interface IDelverBackendAnalysisWire {
	readonly analysisComplete: boolean;
	/** Whether the program was already analyzed, so no work was done. */
	readonly alreadyAnalyzed: boolean;
}

export interface IDelverDecompilerCacheInfoWire {
	readonly path: string;
	readonly projectCount: number;
	readonly fileCount: number;
	readonly byteLength: number;
}

export interface IDelverDecompilerTargetPreparationWire {
	readonly backendId: string;
	readonly backendVersion: string;
	readonly processGeneration: number;
	readonly spawnMs: number;
	readonly handshakeMs: number;
	readonly targetOpenMs: number;
}

/** JSON-safe bytes returned from one provider memory read. */
export interface IDelverReadMemoryWire {
	/** Lowercase hexadecimal bytes, with two characters per byte. */
	readonly bytesHex: string;
	/** Provider-confirmed readable ranges in the requested address space. */
	readonly valid: readonly IRangeWire[];
	/** Target moment at which the provider served the bytes. */
	readonly servedMoment: IMomentWire;
}

/**
 * Analysis, as the renderer sees it.
 *
 * **Every payload here is wire-shaped**: addresses are `"0x..."` strings, never
 * `bigint`. This interface crosses the shared-process boundary, where object
 * payloads are serialized with `JSON.stringify` — a `bigint` anywhere in a
 * return value throws inside the channel server and hangs the caller's promise
 * with no error (ADR 0001, "Scope"). Conversion to `bigint` happens on the
 * renderer side of this boundary, not before it.
 */
export interface IDelverAnalysisService {
	readonly _serviceBrand: undefined;

	/**
	 * Interim progress for a long backend operation, keyed by `operationId`.
	 *
	 * An event rather than a callback because this interface is a proxy across
	 * the shared-process boundary, where a function argument does not survive
	 * the crossing. Nothing is guaranteed to arrive: a backend that reports
	 * nothing is silent here, and a caller must show the operation running
	 * regardless.
	 */
	readonly onDidReportBackendProgress: Event<IDelverBackendProgressWire>;

	/**
	 * Starts a session and analyses the target. Resolves once the image is
	 * indexed and ready to serve listing rows.
	 */
	openImage(config: TargetConfig): Promise<IAnalysisSessionHandle>;

	/**
	 * Fetches a contiguous run of listing rows.
	 */
	listingWindow(sessionId: AnalysisSessionId, startRow: number, count: number): Promise<IListingWindowResult>;

	/**
	 * Row covering `rva`, or `undefined` when nothing is decoded there.
	 *
	 * `containing` asks for the row covering an arbitrary address rather than
	 * requiring an exact instruction boundary — what a jump-to-address needs.
	 */
	rowForAddress(sessionId: AnalysisSessionId, rva: string, containing: boolean): Promise<number | undefined>;

	/**
	 * Address of a row, as a `"0x..."` string.
	 */
	addressForRow(sessionId: AnalysisSessionId, row: number): Promise<string | undefined>;

	/** Reads bounded raw bytes from the loaded image or original file space. */
	readMemory(sessionId: AnalysisSessionId, space: 'image' | 'file', address: string, count: number): Promise<IDelverReadMemoryWire>;

	/**
	 * Detected functions, sorted by address.
	 */
	functions(sessionId: AnalysisSessionId): Promise<IFunctionsResult>;

	/** Returns a bounded basic-block CFG for one exact detected function entry. */
	basicBlocks(sessionId: AnalysisSessionId, functionRva: string, maxBlocks: number): Promise<IBasicBlocksResult>;

	/** Returns bounded direct call-graph edges for one exact detected function entry. */
	callGraph(sessionId: AnalysisSessionId, functionRva: string, maxEdges: number): Promise<ICallGraphResult>;

	/**
	 * Returns bounded call paths between two functions, or from a function to an
	 * import slot.
	 *
	 * `toRva` is either an exact detected function entry or the RVA of an import
	 * address table slot. **An empty `paths` is not a proof of absence**: the
	 * search is bounded, so a caller may only render "no path exists" when
	 * `search_exhausted` is true, neither limit flag is set, and
	 * `unresolved_indirect_sites_on_frontier` is zero.
	 */
	callPaths(sessionId: AnalysisSessionId, fromRva: string, toRva: string, maxDepth: number, maxPaths: number, maxVisited: number): Promise<ICallPathsResult>;

	/** Returns aggregate structure counts for one exact detected function entry. */
	functionProfile(sessionId: AnalysisSessionId, functionRva: string): Promise<IFunctionProfileResult>;

	/** Returns one page of observed global-data addresses. */
	globals(sessionId: AnalysisSessionId, start: number, maxGlobals: number): Promise<IGlobalsResult>;

	/** Returns decoded instructions that reference one observed global-data address. */
	globalAccesses(sessionId: AnalysisSessionId, rva: string, maxAccesses: number): Promise<IGlobalAccessesResult>;

	/**
	 * Image headers: architecture, entry point, sections, and directory counts.
	 */
	imageInfo(sessionId: AnalysisSessionId): Promise<IGetImageInfoResult>;

	/**
	 * Imported modules and the symbols taken from each.
	 */
	imports(sessionId: AnalysisSessionId): Promise<IGetImportsResult>;

	/**
	 * Exported symbols.
	 */
	exports(sessionId: AnalysisSessionId): Promise<IGetExportsResult>;

	/**
	 * Strings found in the image. The result reports whether it was truncated;
	 * a caller must say so rather than presenting a partial list as complete.
	 */
	strings(sessionId: AnalysisSessionId): Promise<IStringsResult>;

	/**
	 * References **to** `rva` — who reaches this address. This is the direction
	 * that lets an analyst work outward from something interesting.
	 */
	xrefsTo(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult>;

	/**
	 * References **from** `rva` — what this address reaches.
	 */
	xrefsFrom(sessionId: AnalysisSessionId, rva: string): Promise<IXrefsResult>;

	/**
	 * Exports one page of the cross-reference table.
	 *
	 * `xrefsTo` and `xrefsFrom` answer a question about one address, and need the
	 * analysed image present to answer it. This walks the whole table instead, so
	 * a `.delverdb` project can retain the references and still answer "who
	 * references this address" after being reopened without its original sample.
	 *
	 * The walk is resumable: pass the previous page's `next_start` as `start`.
	 * **`next_start` is absent exactly when the table has ended** — that absence
	 * is the completeness signal, and it is passed through unchanged. A caller
	 * must not read a short page as the end, nor a missing `next_start` as zero.
	 */
	xrefIndex(sessionId: AnalysisSessionId, start: number, maxXrefs: number, generation?: number): Promise<IXrefIndexResult>;

	/**
	 * Re-derives every fact for a session against a new correction set.
	 *
	 * A correction changes the seeds analysis starts from, so the answer is a
	 * re-derivation rather than an edit to the previous one — which is what
	 * keeps a corrected fact as recomputable as an uncorrected one. The result
	 * reports the function counts either side of the change, because an analyst
	 * approving a correction has to be able to see its exact effect.
	 */
	setCorrections(sessionId: AnalysisSessionId, corrections: readonly IFunctionCorrectionWire[], dataRanges?: readonly IDataRangeCorrectionWire[]): Promise<ISetCorrectionsResult>;

	/**
	 * Re-scans a bounded window of the image for strings.
	 *
	 * The resumable counterpart to {@link strings}: that one serves what was
	 * retained when the image was analysed, and the retention has a cap real
	 * binaries reach. This is how a caller reaches past it.
	 */
	scanStrings(sessionId: AnalysisSessionId, fromRva: string, maxStrings: number): Promise<IScanStringsResult>;

	/** Starts the selected backend and reports the backend that actually answered. */
	decompilerStatus(ghidraHome: string | undefined, pythonPath: string | undefined, backend?: 'pyghidra' | 'headless'): Promise<DelverDecompilerStatusWire>;

	/** Terminates persistent backend state and starts a fresh worker generation. */
	restartDecompiler(ghidraHome: string | undefined, pythonPath: string | undefined, backend?: 'pyghidra' | 'headless'): Promise<DelverDecompilerStatusWire>;

	/** Measures Delver's fixed native decompiler cache without opening a backend. */
	decompilerCacheInfo(): Promise<IDelverDecompilerCacheInfoWire>;

	/** Stops persistent workers and removes only Delver's fixed native cache. */
	clearDecompilerCache(): Promise<IDelverDecompilerCacheInfoWire>;

	/** Runs one decompilation and identifies the backend that emitted its versioned JSON. */
	decompileFunction(sessionId: AnalysisSessionId, rva: string, contentHash: string, ghidraHome: string, pythonPath: string, operationId: string, backend: 'pyghidra' | 'headless', semantics: IDelverDecompilationSemanticsWire): Promise<IDelverDecompilationWire>;

	/**
	 * Every function the configured decompiler backend recovered in one target.
	 *
	 * `undefined` when the backend does not advertise the capability — the
	 * absence of an answer, which a caller must not read as the two function
	 * sets agreeing (ADR 0017).
	 */
	listBackendFunctions(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string, backend: 'pyghidra' | 'headless'): Promise<IDelverBackendFunctionsWire | undefined>;

	/**
	 * Finishes the decompiler backend's analysis of one target.
	 *
	 * Minutes on a large image, so it is never implied by another call.
	 * `undefined` when the backend cannot be asked.
	 */
	analyzeBackendTarget(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string, backend: 'pyghidra' | 'headless', operationId: string): Promise<IDelverBackendAnalysisWire | undefined>;

	/** Starts and opens a verified target in PyGhidra before the first F5 request. */
	prepareDecompilerTarget(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string): Promise<IDelverDecompilerTargetPreparationWire>;

	/** Cancels an in-flight decompilation operation. */
	cancelDecompile(operationId: string): Promise<void>;

	/**
	 * Ends a session and terminates its processes.
	 */
	closeImage(sessionId: AnalysisSessionId): Promise<void>;
}
