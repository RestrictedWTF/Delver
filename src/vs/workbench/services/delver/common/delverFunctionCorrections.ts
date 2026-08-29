/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Authored corrections to the function seed set of one image.
 *
 * Function detection is a guess. A linear sweep invents functions in data it
 * mistook for code, and misses real ones nothing statically references — and an
 * analyst can often see both. A correction is how they say so.
 *
 * It stays on the authored side of the line. The correction records the
 * *decision*; the analysis server re-derives instructions, blocks, and
 * cross-references from the bytes plus the corrected seeds, and nothing here is
 * ever written into the fact store. That is what keeps facts recomputable and
 * the analyst's work separate from them
 * (`Docs/architecture/data-model.md` section 3).
 */

import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { toWireAddress } from './delverAgentTypes.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';

/**
 * One correction to the function seed set.
 *
 * Addresses are `"0x..."` strings because this crosses a wire, where a JSON
 * number would truncate above 2^53 without erroring
 * (`Docs/history/adr/0001-wire-protocol-framing-and-encoding.md`).
 */
export interface IFunctionCorrection {
	/** Canonical "0x..." image RVA. */
	readonly rva: string;
	readonly kind: 'define' | 'undefine';
	/** Exclusive end, `define` only and optional. */
	readonly endRva?: string;
}

/**
 * Builds the accepted function-correction set for one image.
 *
 * Sorted ascending by RVA with at most one entry per RVA, mirroring
 * `semanticDependenciesFor`: the order is a contract with whatever re-derives
 * the facts rather than an implementation detail, and a deterministic snapshot
 * is what lets two of them be compared for equality at all.
 *
 * Exported for tests, which are otherwise the only way to observe the ordering
 * without a live analysis server.
 */
export function functionCorrectionsFor(
	interpretationService: IDelverInterpretationService,
	contentHash: string,
): readonly IFunctionCorrection[] {
	const rvas = new Set<bigint>();
	for (const edit of interpretationService.logFor(contentHash)) {
		if (edit.anchor.kind === 'image' && edit.op === EditOp.FunctionBounds) {
			rvas.add(edit.anchor.rva);
		}
	}
	// The log names the addresses; the materialized view says what is currently
	// accepted at each. A proposal contributes an address and no value, which is
	// exactly right — it is visible in review and absent from the picture.
	const corrections: IFunctionCorrection[] = [];
	for (const rva of [...rvas].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
		const stored = interpretationService.at({ kind: 'image', contentHash, rva })?.functionBounds;
		const correction = stored === undefined ? undefined : parseFunctionCorrection(rva, stored);
		if (correction) {
			corrections.push(correction);
		}
	}
	return corrections;
}

/**
 * Reads one stored correction back into the shape the analysis server expects.
 *
 * A value that no longer parses is dropped rather than sent, for the same
 * reason `parseCompositeLayout` drops a broken layout: it was validated when it
 * was authored, so this only fires on a project edited by hand or written by a
 * newer version, and the honest move is to analyse without that one correction
 * rather than to make the whole image unanalysable over one bad row.
 */
function parseFunctionCorrection(rva: bigint, stored: string): IFunctionCorrection | undefined {
	try {
		const parsed = JSON.parse(stored) as { kind?: unknown; endRva?: unknown };
		if (parsed.kind === 'undefine') {
			return parsed.endRva === undefined ? { rva: toWireAddress(rva), kind: 'undefine' } : undefined;
		}
		if (parsed.kind !== 'define') {
			return undefined;
		}
		if (parsed.endRva === undefined) {
			return { rva: toWireAddress(rva), kind: 'define' };
		}
		if (typeof parsed.endRva !== 'string') {
			return undefined;
		}
		const endRva = BigInt(parsed.endRva);
		return endRva > rva
			? { rva: toWireAddress(rva), kind: 'define', endRva: toWireAddress(endRva) }
			: undefined;
	} catch {
		// `JSON.parse` and `BigInt` both throw on malformed input, and both mean
		// the same thing here: this row cannot be turned into a correction.
		return undefined;
	}
}
