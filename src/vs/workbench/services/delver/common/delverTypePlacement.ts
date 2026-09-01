/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Where a declaration is allowed to attach, for both the analyst and the model.
 *
 * The two placement rules — a data type lands in mapped non-executable memory,
 * a prototype lands on a detected function entry — used to live inside the
 * agent's proposal handler because that is where `imageInfo()` and the resolved
 * function list were to hand. That made the command palette the lax door into
 * the same append-only log: an analyst could declare a struct over `.text`
 * where a model was refused. The rules are about the image, not about who is
 * asking, so they live here and both callers spend them.
 *
 * The facts are passed in rather than fetched, so a caller that already holds
 * them — the agent service caches the function index for a whole session —
 * does not pay for them twice, and so the rules stay testable without a
 * session.
 */

import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { IGetImageInfoResult, IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IDelverSessionService } from './delverSessionService.js';

/**
 * Why a declaration may not attach where it was asked to, or `undefined` for
 * a placement that is fine.
 *
 * A code rather than a message: the agent path answers in the flat English its
 * protocol errors are written in, and the palette answers in the analyst's
 * language. One shared sentence would have to be wrong for one of them.
 */
export type DelverTypePlacementRefusal = 'not-data-memory' | 'not-function-entry';

/** The image facts the two placement rules are decided against. */
export interface IDelverTypePlacementFacts {
	readonly sections: readonly { readonly virtual_address: string; readonly virtual_size: number; readonly executable: boolean }[];
	/** Entry RVAs of every detected function, so a prototype can be pinned to one. */
	readonly functionEntries: ReadonlySet<bigint>;
}

/** Whether `address` falls inside the `size` bytes starting at the wire address `startWire`. */
export function containsWireRange(address: bigint, startWire: string, size: number): boolean {
	const start = BigInt(startWire);
	return address >= start && address < start + BigInt(size);
}

/**
 * Checks one declaration's placement.
 *
 * An empty declaration is always allowed: clearing a field is an append like
 * any other, and refusing to take a bad declaration back would strand it.
 * Composites are checked against nothing — a layout is not a claim about an
 * address, so there is no byte that could confirm or refute it.
 */
export function typePlacementRefusal(
	op: EditOp,
	rva: bigint,
	declaration: string,
	facts: IDelverTypePlacementFacts,
): DelverTypePlacementRefusal | undefined {
	if (declaration.length === 0) {
		return undefined;
	}
	if (op === EditOp.DataType) {
		const section = facts.sections.find(candidate => containsWireRange(rva, candidate.virtual_address, candidate.virtual_size));
		return !section || section.executable ? 'not-data-memory' : undefined;
	}
	if (op === EditOp.FunctionPrototype) {
		return facts.functionEntries.has(rva) ? undefined : 'not-function-entry';
	}
	return undefined;
}

/** Builds the facts from an image and a function list the caller already has. */
export function typePlacementFacts(image: IGetImageInfoResult, functions: readonly IFunctionWire[]): IDelverTypePlacementFacts {
	return {
		sections: image.sections,
		functionEntries: new Set(functions.map(entry => BigInt(entry.rva))),
	};
}

/**
 * Reads the facts one placement check needs from the open session.
 *
 * Only what the op actually consults is fetched: a prototype never looks at
 * sections, and asking for the function list to type a byte at a data address
 * would make the palette wait on an analysis the answer does not depend on.
 * The result is therefore specific to `op` and must not be reused for another.
 */
export async function loadTypePlacementFacts(sessionService: IDelverSessionService, op: EditOp): Promise<IDelverTypePlacementFacts> {
	const [image, functions] = await Promise.all([
		op === EditOp.DataType ? sessionService.imageInfo() : undefined,
		op === EditOp.FunctionPrototype ? sessionService.functions() : undefined,
	]);
	return {
		sections: image?.sections ?? [],
		functionEntries: new Set((functions?.functions ?? []).map(entry => BigInt(entry.rva))),
	};
}
