/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRange } from '../../../../platform/delver/common/address.js';
import { IListingRowWire } from '../../../../platform/delver/common/protocol.generated.js';

/** Whether an instruction overlaps any exact half-open pseudocode source range. */
export function isInstructionHighlighted(row: IListingRowWire, ranges: readonly IRange[]): boolean {
	const start = BigInt(row.rva);
	const end = start + BigInt(row.len);
	return ranges.some(range => rangesOverlap(start, end, range.start, range.end));
}

export function rangesOverlap(leftStart: bigint, leftEnd: bigint, rightStart: bigint, rightEnd: bigint): boolean {
	return leftStart < rightEnd && rightStart < leftEnd;
}
