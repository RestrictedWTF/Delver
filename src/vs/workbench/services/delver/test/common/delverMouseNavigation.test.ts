/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mouseHistoryDirection } from '../../common/delverMouseNavigation.js';

suite('Delver mouse navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps Mouse4 and Mouse5 without claiming ordinary buttons', () => {
		assert.strictEqual(mouseHistoryDirection(3), 'back');
		assert.strictEqual(mouseHistoryDirection(4), 'forward');
		for (const button of [0, 1, 2, 5]) {
			assert.strictEqual(mouseHistoryDirection(button), undefined);
		}
	});
});
