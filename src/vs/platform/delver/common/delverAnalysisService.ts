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

	/**
	 * Ends a session and terminates its processes.
	 */
	closeImage(sessionId: AnalysisSessionId): Promise<void>;
}
