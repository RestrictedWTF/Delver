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
	signatures: { default: 50, max: 200 },
	signatureNameCharacters: DELVER_SIGNATURE_LIMITS.nameCharacters,
	listingRows: { default: 256, max: 2048 },
	functions: { default: 100, max: 1000 },
	xrefs: { default: 100, max: 2000 },
	strings: { default: 100, max: 1000 },
	imports: { default: 100, max: 1000 },
	exports: { default: 100, max: 1000 },
	decompiledFunctions: { default: 1, max: 16 },
	proposals: {
		max: 100,
		renameCharacters: 256,
		commentCharacters: 16 * 1024,
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
 */
interface IDelverAgentCursorPayload {
	readonly h: string;
	readonly r?: string;
	readonly c: string;
	readonly o: number;
	/** Fingerprint of the filter arguments this page was produced under. */
	readonly f?: string;
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

export function encodeCursor(capability: string, project: IDelverAgentProjectIdentity, startIndex: number, filter = ''): string {
	const payload: IDelverAgentCursorPayload = {
		h: project.contentHash,
		...(project.revisionId === undefined ? {} : { r: project.revisionId }),
		c: capability,
		o: startIndex,
		...(filter === '' ? {} : { f: filter }),
	};
	return encodeBase64(VSBuffer.fromString(JSON.stringify(payload)));
}

/**
 * Decodes a cursor, rejecting one issued for other bytes, another capability,
 * or a different filter.
 *
 * Returns the index to resume at. An absent cursor starts at zero.
 */
export function decodeCursor(cursor: unknown, capability: string, project: IDelverAgentProjectIdentity, filter = ''): number {
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
