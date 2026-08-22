/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import {
	IFunctionsResult,
	IGetExportsResult,
	IGetImageInfoResult,
	IGetImportsResult,
	IListingWindowResult,
	IOpenImageResult,
	IStringsResult,
	IXrefsResult,
} from './protocol.generated.js';
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

	/**
	 * Detected functions, sorted by address.
	 */
	functions(sessionId: AnalysisSessionId): Promise<IFunctionsResult>;

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

	/** Starts the selected backend and reports the backend that actually answered. */
	decompilerStatus(ghidraHome: string | undefined, pythonPath: string | undefined, backend?: 'pyghidra' | 'headless'): Promise<DelverDecompilerStatusWire>;

	/** Terminates persistent backend state and starts a fresh worker generation. */
	restartDecompiler(ghidraHome: string | undefined, pythonPath: string | undefined, backend?: 'pyghidra' | 'headless'): Promise<DelverDecompilerStatusWire>;

	/** Measures Delver's fixed native decompiler cache without opening a backend. */
	decompilerCacheInfo(): Promise<IDelverDecompilerCacheInfoWire>;

	/** Stops persistent workers and removes only Delver's fixed native cache. */
	clearDecompilerCache(): Promise<IDelverDecompilerCacheInfoWire>;

	/** Runs one decompilation and identifies the backend that emitted its versioned JSON. */
	decompileFunction(sessionId: AnalysisSessionId, rva: string, contentHash: string, ghidraHome: string, pythonPath: string, operationId: string, backend: 'pyghidra' | 'headless'): Promise<IDelverDecompilationWire>;

	/** Starts and opens a verified target in PyGhidra before the first F5 request. */
	prepareDecompilerTarget(sessionId: AnalysisSessionId, contentHash: string, ghidraHome: string, pythonPath: string): Promise<IDelverDecompilerTargetPreparationWire>;

	/** Cancels an in-flight decompilation operation. */
	cancelDecompile(operationId: string): Promise<void>;

	/**
	 * Ends a session and terminates its processes.
	 */
	closeImage(sessionId: AnalysisSessionId): Promise<void>;
}
