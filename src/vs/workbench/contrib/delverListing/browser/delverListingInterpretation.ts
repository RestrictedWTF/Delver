/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInterpretationAt } from '../../../../platform/delver/common/interpretation.js';
import { functionDisplayName } from '../../../../platform/delver/common/naming.js';

export interface IListingInterpretationPresentation {
	readonly label?: string;
	readonly comment?: string;
	readonly tags?: string;
	readonly linesBeforeInstruction: number;
	readonly heightInLines: number;
}

/**
 * Converts authored interpretation into bounded lines owned by an instruction.
 *
 * Synthetic rows would break the analysis row/address identity used by paging.
 * A label may occupy a line above the instruction; comments stay on the
 * instruction line. Imported multiline comments are folded for display without
 * changing the stored value.
 */
export function listingInterpretationPresentation(
	address: bigint,
	isFunctionStart: boolean,
	interpretation: IInterpretationAt | undefined,
): IListingInterpretationPresentation {
	const label = isFunctionStart
		? functionDisplayName(address, interpretation?.name)
		: interpretation?.name;
	const comment = interpretation?.comment?.replace(/\r\n|\r|\n/g, ' ⏎ ');
	const tags = interpretation?.tags?.map(tag => `#${tag}`).join(' ');
	const linesBeforeInstruction = label === undefined ? 0 : 1;
	return {
		label,
		comment,
		tags,
		linesBeforeInstruction,
		heightInLines: 1 + linesBeforeInstruction,
	};
}
