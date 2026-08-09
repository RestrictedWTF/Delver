/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { listingInterpretationPresentation } from '../../browser/delverListingInterpretation.js';

suite('Delver listing interpretation presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an unnamed function keeps its landmark line', () => {
		assert.deepStrictEqual(
			listingInterpretationPresentation(0x1000n, true, undefined),
			{
				label: 'sub_1000',
				comment: undefined,
				tags: undefined,
				linesBeforeInstruction: 1,
				heightInLines: 2,
			},
		);
	});

	test('an arbitrary name adds a label line while its comment stays inline', () => {
		assert.deepStrictEqual(
			listingInterpretationPresentation(0x1004n, false, { name: 'key_length', comment: 'bytes, not bits' }),
			{
				label: 'key_length',
				comment: 'bytes, not bits',
				tags: undefined,
				linesBeforeInstruction: 1,
				heightInLines: 2,
			},
		);
	});

	test('imported multiline comments stay one bounded display line', () => {
		assert.deepStrictEqual(
			listingInterpretationPresentation(0x1008n, false, { comment: 'first\r\nsecond\nthird' }),
			{
				label: undefined,
				comment: 'first ⏎ second ⏎ third',
				tags: undefined,
				linesBeforeInstruction: 0,
				heightInLines: 1,
			},
		);
	});

	test('tags stay on the instruction line and do not change its height', () => {
		assert.deepStrictEqual(
			listingInterpretationPresentation(0x1010n, false, { tags: ['crypto', 'reviewed'] }),
			{
				label: undefined,
				comment: undefined,
				tags: '#crypto #reviewed',
				linesBeforeInstruction: 0,
				heightInLines: 1,
			},
		);
	});
});
