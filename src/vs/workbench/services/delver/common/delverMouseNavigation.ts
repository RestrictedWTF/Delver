/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type MouseHistoryDirection = 'back' | 'forward';

/** Browser mouse button numbering is zero-based: Mouse4 is `3`, Mouse5 is `4`. */
export function mouseHistoryDirection(button: number): MouseHistoryDirection | undefined {
	switch (button) {
		case 3: return 'back';
		case 4: return 'forward';
		default: return undefined;
	}
}
