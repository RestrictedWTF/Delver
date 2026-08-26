/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';

/** Finds a detected function containing `rva` without requiring an entry-row focus. */
export function containingFunctionRva(functions: readonly IFunctionWire[], rva: bigint): bigint | undefined {
	let low = 0;
	let high = functions.length - 1;
	let candidate: IFunctionWire | undefined;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const start = BigInt(functions[middle].rva);
		if (start <= rva) {
			candidate = functions[middle];
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (!candidate || candidate.end_rva !== undefined && rva >= BigInt(candidate.end_rva)) {
		return undefined;
	}
	return BigInt(candidate.rva);
}
