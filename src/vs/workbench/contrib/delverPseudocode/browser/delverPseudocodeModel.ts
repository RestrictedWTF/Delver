/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRange } from '../../../../platform/delver/common/address.js';
import { decompilerLinesForRva, IDecompiledFunction, rangesForDecompilerLine } from '../../../services/delver/common/delverDecompilerService.js';

/** Focus payload represented by one pseudocode line. */
export interface IPseudocodeLineFocus {
	readonly address: bigint;
	readonly selection: IRange;
}

/**
 * Maps a pseudocode line to its first instruction and the bounding recovered
 * range. The backend retains the exact discontiguous ranges; the focus bus has
 * one contiguous selection and therefore carries their smallest bounding span.
 */
export function focusForPseudocodeLine(result: IDecompiledFunction, line: number): IPseudocodeLineFocus | undefined {
	const ranges = [...rangesForDecompilerLine(result, line)].sort((left, right) => {
		if (left.startRva === right.startRva) {
			return left.endRva < right.endRva ? -1 : left.endRva > right.endRva ? 1 : 0;
		}
		return left.startRva < right.startRva ? -1 : 1;
	});
	if (ranges.length === 0) {
		return undefined;
	}

	return {
		address: ranges[0].startRva,
		selection: {
			start: ranges[0].startRva,
			end: ranges.reduce((end, range) => range.endRva > end ? range.endRva : end, ranges[0].endRva),
		},
	};
}

/** Returns the first pseudocode line representing an image-relative address. */
export function pseudocodeLineForRva(result: IDecompiledFunction, rva: bigint): number | undefined {
	return decompilerLinesForRva(result, rva)[0];
}
