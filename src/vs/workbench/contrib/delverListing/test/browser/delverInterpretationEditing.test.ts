/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { interpretationRvaFromHandle, parseTags } from '../../../../services/delver/browser/delverInterpretationEditing.js';

suite('Delver interpretation editing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tag input is trimmed, deduplicated, and sorted for persistence', () => {
		assert.deepStrictEqual(parseTags(' review,crypto, review, ,config '), ['config', 'crypto', 'review']);
	});

	test('actionable view handles preserve a wire-safe 64-bit RVA', () => {
		assert.strictEqual(
			interpretationRvaFromHandle('delver.import.symbol.2.7.0x1000000000000001'),
			0x1000000000000001n,
		);
		assert.strictEqual(interpretationRvaFromHandle('delver.export.3.forwarded'), undefined);
	});
});
