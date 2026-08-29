/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FlowKindWire, IFunctionWire, IListingRowWire } from './protocol.generated.js';

/** Versioned listing normalization used by {@link fingerprintFunctionListing}. */
export const FUNCTION_LISTING_FINGERPRINT_NORMALIZATION = 'delver-listing-v2';

/** A relocation-normalized function fingerprint produced by an analysis provider. */
export interface INormalizedFunctionFingerprint {
	/** Digest algorithm, for example `sha256`. */
	readonly algorithm: string;
	/** Versioned normalization profile, for example `x86-relocations-v1`. */
	readonly normalization: string;
	/** Digest of the normalized function representation. */
	readonly digest: string;
}

/** A detected function paired with the fingerprint used to track it across revisions. */
export interface IFingerprintedFunction {
	readonly function: IFunctionWire;
	readonly fingerprint: INormalizedFunctionFingerprint;
}

/** The functions and identity of one target revision. */
export interface IFunctionRevision {
	readonly contentHash: string;
	readonly functions: readonly IFingerprintedFunction[];
}

/** The exact matching method currently implemented. */
export const enum FunctionRevisionMatchMethod {
	NormalizedFingerprintExact = 'normalizedFingerprintExact',
}

/** Evidence that explains why two functions were associated. */
export interface IFunctionRevisionMatchProvenance {
	readonly sourceContentHash: string;
	readonly targetContentHash: string;
	readonly fingerprint: INormalizedFunctionFingerprint;
}

/** An unambiguous function association between two target revisions. */
export interface IFunctionRevisionMatch {
	readonly source: IFunctionWire;
	readonly target: IFunctionWire;
	/** Exact normalized-fingerprint matches have confidence 1. */
	readonly confidence: number;
	readonly method: FunctionRevisionMatchMethod;
	readonly provenance: IFunctionRevisionMatchProvenance;
}

/** An exact fingerprint shared by multiple functions in either revision. */
export interface IAmbiguousFunctionRevisionMatch {
	readonly source: readonly IFunctionWire[];
	readonly target: readonly IFunctionWire[];
	readonly method: FunctionRevisionMatchMethod;
	readonly provenance: IFunctionRevisionMatchProvenance;
}

/** Complete output from a bounded exact revision match. */
export interface IFunctionRevisionMatchResult {
	readonly matches: readonly IFunctionRevisionMatch[];
	readonly ambiguous: readonly IAmbiguousFunctionRevisionMatch[];
	readonly unmatchedSource: readonly IFunctionWire[];
	readonly unmatchedTarget: readonly IFunctionWire[];
}

interface IIndexedFunction {
	readonly index: number;
	readonly value: IFingerprintedFunction;
}

function normalizedText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizedRva(value: string): string {
	try {
		return BigInt(value).toString(16);
	} catch {
		return value.trim().toLowerCase();
	}
}

function isDirectControlFlow(flow: FlowKindWire): boolean {
	return flow === FlowKindWire.Jump || flow === FlowKindWire.ConditionalJump || flow === FlowKindWire.Call;
}

/**
 * Produces the canonical instruction sequence hashed for revision matching.
 *
 * Row ordinals and RVAs are omitted. Known direct branch/call targets are
 * represented as a target instruction index when local to the function, or as
 * `external` otherwise. Other operands remain intact because the current wire
 * shape does not identify address-bearing memory operands separately from
 * numeric constants; changing those speculatively would create false matches.
 */
export function normalizeFunctionListing(rows: readonly IListingRowWire[]): string {
	const rowByRva = new Map<string, number>();
	for (let index = 0; index < rows.length; index++) {
		rowByRva.set(normalizedRva(rows[index].rva), index);
	}

	return JSON.stringify(rows.map(row => {
		let operands = normalizedText(row.operands);
		if (isDirectControlFlow(row.flow) && row.branch_target !== undefined) {
			const localTarget = rowByRva.get(normalizedRva(row.branch_target));
			operands = localTarget === undefined ? 'external' : `local:${localTarget}`;
		}
		return [row.len, row.flow, normalizedText(row.mnemonic), operands];
	}));
}

function rotateRight(value: number, count: number): number {
	return (value >>> count) | (value << (32 - count));
}

function sha256(value: string): string {
	const constants = [
		0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
		0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
		0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
		0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
		0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
		0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
		0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
		0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
	];
	const state = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
	const bytes = new TextEncoder().encode(value);
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLength = bytes.length * 8;
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);
	const words = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) {
			words[index] = view.getUint32(offset + index * 4, false);
		}
		for (let index = 16; index < 64; index++) {
			const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
			const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}

		state[0] = (state[0] + a) >>> 0;
		state[1] = (state[1] + b) >>> 0;
		state[2] = (state[2] + c) >>> 0;
		state[3] = (state[3] + d) >>> 0;
		state[4] = (state[4] + e) >>> 0;
		state[5] = (state[5] + f) >>> 0;
		state[6] = (state[6] + g) >>> 0;
		state[7] = (state[7] + h) >>> 0;
	}

	return state.map(word => word.toString(16).padStart(8, '0')).join('');
}

/** Creates a durable exact fingerprint from existing listing wire rows. */
export function fingerprintFunctionListing(rows: readonly IListingRowWire[]): INormalizedFunctionFingerprint {
	return {
		algorithm: 'sha256',
		normalization: FUNCTION_LISTING_FINGERPRINT_NORMALIZATION,
		digest: sha256(normalizeFunctionListing(rows)),
	};
}

function canonicalFingerprint(fingerprint: INormalizedFunctionFingerprint): { readonly key: string; readonly fingerprint: INormalizedFunctionFingerprint } {
	const algorithm = fingerprint.algorithm.trim().toLowerCase();
	const normalization = fingerprint.normalization.trim().toLowerCase();
	const digest = fingerprint.digest.trim().toLowerCase();
	if (!algorithm || !normalization || !digest) {
		throw new Error('A normalized function fingerprint requires an algorithm, normalization profile, and digest.');
	}

	return {
		key: `${algorithm}\u0000${normalization}\u0000${digest}`,
		fingerprint: { algorithm, normalization, digest },
	};
}

function groupFunctions(functions: readonly IFingerprintedFunction[]): Map<string, IIndexedFunction[]> {
	const groups = new Map<string, IIndexedFunction[]>();
	for (let index = 0; index < functions.length; index++) {
		const value = functions[index];
		const { key } = canonicalFingerprint(value.fingerprint);
		const group = groups.get(key);
		if (group) {
			group.push({ index, value });
		} else {
			groups.set(key, [{ index, value }]);
		}
	}
	return groups;
}

/**
 * Associates functions across two revisions using exact normalized fingerprints.
 *
 * A fingerprint must be unique in both revisions before it is accepted. Repeated
 * compiler thunks and identical folded functions are returned as ambiguous rather
 * than being paired by address or array order. Structural fuzzy matching is a
 * separate future pass and is deliberately not attempted here.
 */
export function matchFunctionRevisions(source: IFunctionRevision, target: IFunctionRevision): IFunctionRevisionMatchResult {
	const sourceGroups = groupFunctions(source.functions);
	const targetGroups = groupFunctions(target.functions);
	const matchedSource = new Set<number>();
	const matchedTarget = new Set<number>();
	const matches: IFunctionRevisionMatch[] = [];
	const ambiguous: IAmbiguousFunctionRevisionMatch[] = [];

	for (const [key, sourceGroup] of sourceGroups) {
		const targetGroup = targetGroups.get(key);
		if (!targetGroup) {
			continue;
		}

		const fingerprint = canonicalFingerprint(sourceGroup[0].value.fingerprint).fingerprint;
		const provenance: IFunctionRevisionMatchProvenance = {
			sourceContentHash: source.contentHash,
			targetContentHash: target.contentHash,
			fingerprint,
		};

		if (sourceGroup.length === 1 && targetGroup.length === 1) {
			const sourceFunction = sourceGroup[0];
			const targetFunction = targetGroup[0];
			matchedSource.add(sourceFunction.index);
			matchedTarget.add(targetFunction.index);
			matches.push({
				source: sourceFunction.value.function,
				target: targetFunction.value.function,
				confidence: 1,
				method: FunctionRevisionMatchMethod.NormalizedFingerprintExact,
				provenance,
			});
			continue;
		}

		ambiguous.push({
			source: sourceGroup.map(item => item.value.function),
			target: targetGroup.map(item => item.value.function),
			method: FunctionRevisionMatchMethod.NormalizedFingerprintExact,
			provenance,
		});
	}

	return {
		matches,
		ambiguous,
		unmatchedSource: source.functions.filter((_, index) => !matchedSource.has(index)).map(value => value.function),
		unmatchedTarget: target.functions.filter((_, index) => !matchedTarget.has(index)).map(value => value.function),
	};
}
