/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FlowKindWire, IListingRowWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { isInstructionHighlighted } from '../../browser/delverListingHighlights.js';

suite('Delver listing pseudocode highlights', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function row(rva: string, len: number): IListingRowWire {
		return { rva, len, row: 0, mnemonic: 'nop', operands: '', flow: FlowKindWire.Sequential };
	}

	test('highlights only instructions overlapping exact discontiguous ranges', () => {
		const ranges = [{ start: 0x1001n, end: 0x1003n }, { start: 0x1010n, end: 0x1012n }];
		assert.deepStrictEqual([
			isInstructionHighlighted(row('0x1000', 2), ranges),
			isInstructionHighlighted(row('0x1003', 4), ranges),
			isInstructionHighlighted(row('0x1008', 8), ranges),
			isInstructionHighlighted(row('0x1010', 1), ranges),
		], [true, false, false, true]);
	});

	test('uses half-open boundaries', () => {
		assert.deepStrictEqual([
			isInstructionHighlighted(row('0x1000', 4), [{ start: 0x1004n, end: 0x1008n }]),
			isInstructionHighlighted(row('0x1004', 4), [{ start: 0x1000n, end: 0x1004n }]),
		], [false, false]);
	});
});
