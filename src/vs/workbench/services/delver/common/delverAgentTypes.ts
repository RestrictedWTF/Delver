/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The JSON-safe contract every Delver agent caller shares.
 *
 * One shape crosses three boundaries — the in-renderer chat tools, the private
 * command gateway, and later the MCP/Python adapters — so it is defined once
 * and contains nothing that cannot survive `JSON.stringify`. In particular
 * **every address is a `"0x..."` string, never a JSON number**: JSON numbers
 * truncate above 2^53 without erroring, which would silently corrupt an
 * address in a 64-bit image (`Docs/history/adr/0001-...`).
 *
 * The envelope exists so a model can tell a complete answer from a truncated
 * one, and so every claim it later makes can be traced back to the bytes that
 * produced it. A bare payload cannot do either.
 */

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { DELVER_FINDING_LIMITS } from '../../../../platform/delver/common/findings.js';
import { DELVER_SIGNATURE_LIMITS } from '../../../../platform/delver/common/delverSignature.js';

/** Envelope version. Bump only for a breaking change to the envelope itself. */
export const DELVER_AGENT_SCHEMA_VERSION = 1;

/**
 * Stable error codes. Agents branch on these; diagnostics are for humans.
 *
 * This list is the contract in `Docs/planning/ai-integration-plan.md` §3. Do
 * not add a code without updating that document — an adapter that sees an
 * unknown code cannot decide whether to retry, re-authenticate, or give up.
 */
export const enum DelverAgentErrorCode {
	NoActiveProject = 'NO_ACTIVE_PROJECT',
	TargetNotAttached = 'TARGET_NOT_ATTACHED',
	AddressNotMapped = 'ADDRESS_NOT_MAPPED',
	FunctionNotFound = 'FUNCTION_NOT_FOUND',
	CapabilityUnavailable = 'CAPABILITY_UNAVAILABLE',
	AnalysisIncomplete = 'ANALYSIS_INCOMPLETE',
	DecompilerUnavailable = 'DECOMPILER_UNAVAILABLE',
	ResultLimitExceeded = 'RESULT_LIMIT_EXCEEDED',
	StaleRevision = 'STALE_REVISION',
	InvalidArgument = 'INVALID_ARGUMENT',
	Cancelled = 'CANCELLED',
	/**
	 * A write needs a human to confirm it before it can proceed.
	 *
	 * Nothing throws this yet: every write capability today appends a
	 * *proposal*, which needs no confirmation because it changes nothing until
	 * a reviewer accepts it. Reserved for the first capability that acts
	 * directly — and advertised through `delver_capabilities` now so a client
	 * handling the code is not surprised by it later.
	 */
	ConfirmationRequired = 'CONFIRMATION_REQUIRED',
	InternalError = 'INTERNAL_ERROR',
}

/**
 * Every code, as data.
 *
 * A `const enum` has no runtime representation, and `delver_capabilities` has
 * to be able to *tell* a caller what it might return.
 */
export const DELVER_AGENT_ERROR_CODES: readonly string[] = [
	'NO_ACTIVE_PROJECT', 'TARGET_NOT_ATTACHED', 'ADDRESS_NOT_MAPPED', 'FUNCTION_NOT_FOUND',
	'CAPABILITY_UNAVAILABLE', 'ANALYSIS_INCOMPLETE', 'DECOMPILER_UNAVAILABLE', 'RESULT_LIMIT_EXCEEDED',
	'STALE_REVISION', 'INVALID_ARGUMENT', 'CANCELLED', 'CONFIRMATION_REQUIRED', 'INTERNAL_ERROR',
];

/** A dispatcher failure carrying a code an adapter can branch on. */
export class DelverAgentError extends Error {
	override readonly name = 'DelverAgentError';

	constructor(
		readonly code: DelverAgentErrorCode,
		message: string,
		readonly diagnostic?: string,
	) {
		super(message);
	}
}

/** A half-open image-relative range, as wire-safe hexadecimal strings. */
export interface IDelverAgentRangeWire {
	readonly start: string;
	readonly end: string;
}

/**
 * Where one part of a result came from.
 *
 * Provenance is not decoration: it is the difference between "the model says
 * this function decrypts a config blob" and "the model says so, and here are
 * the byte ranges and the tool call it read". P3c hangs evidence edges off
 * exactly these records.
 */
export interface IDelverAgentProvenance {
	readonly source: 'session' | 'analysis' | 'project' | 'decompiler' | 'interpretation' | 'finding' | 'focus';
	/** Human-readable statement of what was read. */
	readonly detail: string;
	readonly contentHash?: string;
	readonly revisionId?: string;
	readonly addresses?: readonly string[];
	readonly ranges?: readonly IDelverAgentRangeWire[];
	readonly backendId?: string;
	readonly backendVersion?: string;
	/**
	 * True when the payload contains sample-derived bytes or text.
	 *
	 * Strings, symbol names, and pseudocode identifiers all originate in an
	 * attacker-controlled file. They are data for the model to reason about,
	 * never instructions for it to follow.
	 */
	readonly untrusted?: boolean;
}

/** Whether the payload is everything the caller asked for. */
export type DelverAgentCompleteness = 'complete' | 'partial' | 'stale';

/** Project identity a result was computed against. */
export interface IDelverAgentProjectIdentity {
	readonly contentHash: string;
	readonly revisionId?: string;
	readonly projectPath?: string;
}

/** The single result shape every capability returns. */
export interface IDelverAgentResult<T = unknown> {
	readonly schemaVersion: typeof DELVER_AGENT_SCHEMA_VERSION;
	readonly callId: string;
	readonly capability: string;
	readonly project?: IDelverAgentProjectIdentity;
	readonly provenance: readonly IDelverAgentProvenance[];
	readonly completeness: DelverAgentCompleteness;
	readonly omitted?: { readonly count?: number; readonly reason: string };
	readonly nextCursor?: string;
	readonly data: T;
}

/** One invocation. `args` is whatever the capability's schema accepts. */
export interface IDelverAgentRequest {
	readonly capability: string;
	readonly args?: Readonly<Record<string, unknown>>;
	/**
	 * Optional fail-closed binding supplied by a transport session. `null`
	 * means the session was bound while no project was active.
	 */
	readonly expectedProject?: Pick<IDelverAgentProjectIdentity, 'contentHash' | 'revisionId'> | null;
	/** Identity of the caller, recorded on any authored write. */
	readonly caller?: IDelverAgentCaller;
}

export interface IDelverAgentCaller {
	readonly kind: 'model' | 'human' | 'rule' | 'import';
	readonly id: string;
}

/** Which tool group a capability belongs to, for lazy discovery. */
export type DelverAgentGroup = 'core' | 'analysis' | 'types' | 'proposals';

/** What a capability does, so a caller need not hardcode the catalog. */
export interface IDelverAgentCapability {
	readonly id: string;
	readonly group: DelverAgentGroup;
	/** `ui` capabilities move the workbench; they author nothing. */
	readonly kind: 'read' | 'write' | 'ui';
	readonly title: string;
	readonly description: string;
	/** True when the capability needs the original sample attached. */
	readonly requiresAttachedTarget: boolean;
}

/**
 * Output limits.
 *
 * A default that fills a model's context is a bug, not a convenience: the next
 * call has nowhere to go. Every inventory capability paginates to the default
 * and says so rather than quietly returning less than was asked for.
 */
export const DELVER_AGENT_LIMITS = {
	bytes: { default: 256, max: 64 * 1024 },
	bytePatternBytes: 256,
	byteSearchMatches: { default: 100, max: 256 },
	instructionSearchMatches: { default: 100, max: 256 },
	signatures: { default: 50, max: 200 },
	signatureNameCharacters: DELVER_SIGNATURE_LIMITS.nameCharacters,
	listingRows: { default: 256, max: 2048 },
	basicBlocks: { default: 128, max: 512 },
	callGraphEdges: { default: 100, max: 500 },
	/** How many calls deep one call-path search may follow. */
	callPathDepth: { default: 6, max: 16 },
	/** How many distinct call paths one search may return. */
	callPaths: { default: 8, max: 64 },
	functions: { default: 100, max: 1000 },
	globals: { default: 100, max: 1000 },
	globalAccesses: { default: 100, max: 2000 },
	xrefs: { default: 100, max: 2000 },
	strings: { default: 100, max: 1000 },
	imports: { default: 100, max: 1000 },
	exports: { default: 100, max: 1000 },
	decompiledFunctions: { default: 1, max: 16 },
	proposals: {
		max: 100,
		renameCharacters: 256,
		commentCharacters: 16 * 1024,
		declarationCharacters: 2048,
		/** Fields in one proposed composite. Matches the worker's own cap. */
		compositeFields: 1000,
		/** Total size of one proposed composite. Matches the worker's own cap. */
		compositeSizeBytes: 1024 * 1024,
		tagsPerAddress: 32,
		tagCharacters: 64,
	},
	findings: DELVER_FINDING_LIMITS,
	/** Hard ceiling on one serialized result, in bytes. */
	serializedBytes: 256 * 1024,
} as const;

/**
 * Clamps a caller-supplied count into a capability's bounds.
 *
 * A missing or unparseable count takes the default rather than failing: the
 * useful answer to "how many?" left blank is "a page", not an error.
 */
export function boundedCount(value: unknown, limit: { readonly default: number; readonly max: number }): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return limit.default;
	}
	const truncated = Math.trunc(value);
	if (truncated <= 0) {
		return limit.default;
	}
	return Math.min(truncated, limit.max);
}

/**
 * Canonical wire spelling of an address: lowercase `0x` hexadecimal.
 *
 * Every address leaving the dispatcher goes through here, so a caller can
 * compare two addresses as strings and a cursor cannot be forged by respelling
 * one.
 */
export function toWireAddress(value: bigint): string {
	return `0x${value.toString(16)}`;
}

/**
 * Parses a caller-supplied address.
 *
 * Accepts `"0x1000"`, `"1000"` (decimal), and — reluctantly — a JSON number,
 * because models emit them. A number above `Number.MAX_SAFE_INTEGER` has
 * already lost precision by the time it reaches this function and is rejected
 * rather than silently mapped to the wrong instruction.
 */
export function parseWireAddress(value: unknown, what = 'address'): bigint {
	if (typeof value === 'bigint') {
		return assertNonNegative(value, what);
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw new DelverAgentError(
				DelverAgentErrorCode.InvalidArgument,
				`The ${what} was sent as a JSON number that cannot be represented exactly. Send addresses as "0x..." strings.`,
			);
		}
		return assertNonNegative(BigInt(value), what);
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			throw new DelverAgentError(DelverAgentErrorCode.InvalidArgument, `The ${what} is empty.`);
		}
		try {
			return assertNonNegative(BigInt(trimmed), what);
		} catch {
			throw new DelverAgentError(
				DelverAgentErrorCode.InvalidArgument,
				`"${trimmed}" is not a valid ${what}. Use a "0x..." hexadecimal string.`,
			);
		}
	}
	throw new DelverAgentError(DelverAgentErrorCode.InvalidArgument, `A ${what} is required.`);
}

function assertNonNegative(value: bigint, what: string): bigint {
	if (value < 0n) {
		throw new DelverAgentError(DelverAgentErrorCode.InvalidArgument, `A ${what} cannot be negative.`);
	}
	return value;
}

/** Optional address argument: absent stays absent, present must be valid. */
export function parseOptionalWireAddress(value: unknown, what = 'address'): bigint | undefined {
	return value === undefined || value === null ? undefined : parseWireAddress(value, what);
}

/**
 * A pagination cursor bound to the bytes **and the query** it was issued for.
 *
 * Continuing a listing walk against a different revision would interleave two
 * binaries' rows into one apparently coherent answer. The same hazard exists
 * one level down: an index into functions matching `crypt` is meaningless
 * against functions matching `alloc`, and reusing it skips and repeats rows
 * with no outward sign that anything went wrong. Content hash, revision,
 * capability, and a fingerprint of the filter arguments therefore all travel
 * inside the cursor, so every one of those mistakes is detectable rather than
 * merely unlikely.
 *
 * The last of those hazards is the one that fires without anybody doing
 * anything wrong: some sequences are ordered or filtered by *authored* state,
 * which the analyst can change while the walk is in progress. Accepting a
 * rename moves a function into or out of a `nameContains` result; saving a
 * signature inserts a row into a name-sorted list and shifts every later index
 * by one. Neither touches the content hash or the revision, so the cursor
 * still validates and the next page silently skips or repeats rows — and the
 * model reports an inventory that was never true at any instant. A cursor over
 * such a sequence therefore also carries a stamp of the collection state it
 * was minted against.
 */
interface IDelverAgentCursorPayload {
	readonly h: string;
	readonly r?: string;
	readonly c: string;
	readonly o: number;
	/** Fingerprint of the filter arguments this page was produced under. */
	readonly f?: string;
	/** Stamp of the mutable collection this page was sliced from. */
	readonly s?: string;
	/**
	 * Address a re-scanning walk resumes at, as a `"0x..."` string.
	 *
	 * Present only once a walk has run past the end of a materialized list and
	 * into territory that has to be produced on demand. `o` indexes a list; this
	 * indexes an image, and the two phases cannot share a field because one is
	 * an offset into something already held and the other is a position in
	 * something not yet looked at.
	 */
	readonly v?: string;
}

/**
 * Stable fingerprint of the arguments that decide *which* items are paged.
 *
 * Only filtering arguments belong here — `count` changes the page size, not
 * the sequence, and folding it in would force a needless restart.
 */
export function filterFingerprint(values: Readonly<Record<string, unknown>>): string {
	const entries = Object.keys(values)
		.sort()
		.filter(key => values[key] !== undefined && values[key] !== null)
		.map(key => `${key}=${JSON.stringify(values[key])}`);
	return entries.join('&');
}

/**
 * Stamp of a collection whose membership or order the analyst can change.
 *
 * `''` means the sequence is derived from facts alone and cannot shift under
 * the walk. Anything else is compared verbatim on the next page, so a cheap
 * monotonic counter is enough — the stamp never has to describe *what*
 * changed, only that something did.
 */
export function collectionStamp(parts: readonly (string | number)[]): string {
	return parts.join(':');
}

export function encodeCursor(capability: string, project: IDelverAgentProjectIdentity, startIndex: number, filter = '', state = '', scanRva = ''): string {
	const payload: IDelverAgentCursorPayload = {
		h: project.contentHash,
		...(project.revisionId === undefined ? {} : { r: project.revisionId }),
		c: capability,
		o: startIndex,
		...(filter === '' ? {} : { f: filter }),
		...(state === '' ? {} : { s: state }),
		...(scanRva === '' ? {} : { v: scanRva }),
	};
	return encodeBase64(VSBuffer.fromString(JSON.stringify(payload)));
}

/**
 * The scan position a cursor carries, when it has run past a materialized list.
 *
 * Read *after* `decodeCursor` has accepted the cursor, so this never has to
 * repeat the identity, capability, filter and collection checks — it answers
 * only "which phase of the walk is this", and only for a cursor already known
 * to belong here.
 */
export function decodeScanRva(cursor: unknown): string | undefined {
	if (typeof cursor !== 'string' || cursor === '') {
		return undefined;
	}
	try {
		const payload = JSON.parse(decodeBase64(cursor).toString()) as IDelverAgentCursorPayload;
		if (typeof payload.v !== 'string') {
			return undefined;
		}
		// Re-parsed rather than trusted: a cursor is opaque to the caller but it
		// is still caller-supplied bytes, and this one becomes a scan position.
		return toWireAddress(parseWireAddress(payload.v, 'cursor scan position'));
	} catch {
		return undefined;
	}
}

/**
 * Decodes a cursor, rejecting one issued for other bytes, another capability,
 * a different filter, or a collection that has changed underneath the walk.
 *
 * Returns the index to resume at. An absent cursor starts at zero.
 */
export function decodeCursor(cursor: unknown, capability: string, project: IDelverAgentProjectIdentity, filter = '', state = ''): number {
	if (cursor === undefined || cursor === null || cursor === '') {
		return 0;
	}
	if (typeof cursor !== 'string') {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, 'The pagination cursor is not a string issued by Delver.');
	}
	let payload: IDelverAgentCursorPayload;
	try {
		payload = JSON.parse(decodeBase64(cursor).toString()) as IDelverAgentCursorPayload;
	} catch {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, 'The pagination cursor is not one Delver issued.');
	}
	if (payload.c !== capability) {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, `That cursor was issued for ${payload.c}, not ${capability}.`);
	}
	if (payload.h !== project.contentHash || (payload.r ?? undefined) !== project.revisionId) {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, 'That cursor was issued against a different project revision. Restart the walk.');
	}
	if ((payload.f ?? '') !== filter) {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, 'That cursor was issued for different filter arguments. Repeat the original filter, or restart the walk without a cursor.');
	}
	if ((payload.s ?? '') !== state) {
		throw new DelverAgentError(
			DelverAgentErrorCode.StaleRevision,
			'Authored state changed since that cursor was issued, so the remaining rows no longer line up with it. Restart the walk without a cursor; any rows you already collected may be missing or duplicated.',
		);
	}
	if (!Number.isSafeInteger(payload.o) || payload.o < 0) {
		throw new DelverAgentError(DelverAgentErrorCode.StaleRevision, 'The pagination cursor carries an invalid position.');
	}
	return payload.o;
}

/** One page of an inventory, plus what the caller needs to continue or stop. */
export interface IDelverAgentPage<T> {
	readonly items: readonly T[];
	readonly nextIndex?: number;
	readonly omittedCount: number;
	readonly total: number;
}

/** Slices `items` into a page. Pure, so pagination is testable on its own. */
export function paginate<T>(items: readonly T[], startIndex: number, count: number): IDelverAgentPage<T> {
	const page = items.slice(startIndex, startIndex + count);
	const nextIndex = startIndex + page.length;
	const remaining = Math.max(0, items.length - nextIndex);
	return {
		items: page,
		nextIndex: remaining > 0 ? nextIndex : undefined,
		omittedCount: remaining,
		total: items.length,
	};
}

/**
 * Whether a result fits the serialized budget.
 *
 * Measured on the encoded form rather than an item count, because one
 * pathological pseudocode body can outweigh a thousand listing rows.
 */
export function serializedByteLength(value: unknown): number {
	return VSBuffer.fromString(JSON.stringify(value) ?? '').byteLength;
}
