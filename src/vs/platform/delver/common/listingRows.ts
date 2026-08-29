/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IListingWindowRowWire } from './protocol.generated.js';

/**
 * Narrowing for the unified listing row union.
 *
 * A listing row is not always an instruction — it spans the whole image in
 * address order, so strings appear where they live
 * (`Docs/history/adr/0009-unified-address-ordered-listing.md`). Callers that
 * want one kind specifically narrow through here rather than each re-deriving
 * the discriminant, and both the listing view and the agent bridge need it, so
 * it sits below both.
 */

/** A listing row holding a decoded instruction. */
export type IInstructionRowWire = Extract<IListingWindowRowWire, { kind: 'instruction' }>;

/** A listing row holding a string found by the scanner. */
export type IStringRowWire = Extract<IListingWindowRowWire, { kind: 'string' }>;

export function isInstructionRow(row: IListingWindowRowWire): row is IInstructionRowWire {
	return row.kind === 'instruction';
}

export function isStringRow(row: IListingWindowRowWire): row is IStringRowWire {
	return row.kind === 'string';
}
