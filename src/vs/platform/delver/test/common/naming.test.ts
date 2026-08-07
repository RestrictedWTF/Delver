/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	functionDisplayName,
	isPlaceholderName,
	placeholderFunctionName,
	placeholderLocationName,
} from '../../common/naming.js';

suite('Delver naming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('placeholders match the convention analysts already type', () => {
		// Bare uppercase hex, no 0x — these get pasted into notes and tickets,
		// and must be recognisable to anyone coming from IDA.
		assert.deepStrictEqual(
			[placeholderFunctionName(0x140001000n), placeholderLocationName(0x1000n)],
			['sub_140001000', 'loc_1000'],
		);
	});

	test('the full u64 range survives', () => {
		assert.strictEqual(
			placeholderFunctionName(0xFFFFFFFFFFFFFFFFn),
			'sub_FFFFFFFFFFFFFFFF',
		);
	});

	test('an authored name wins over the placeholder', () => {
		assert.strictEqual(functionDisplayName(0x1000n, 'decrypt_config'), 'decrypt_config');
	});

	test('clearing a name restores the placeholder rather than blanking the row', () => {
		assert.deepStrictEqual(
			[functionDisplayName(0x1000n, undefined), functionDisplayName(0x1000n, '')],
			['sub_1000', 'sub_1000'],
		);
	});

	test('a placeholder is recognisable as one', () => {
		// Nothing may write a placeholder into the interpretation log: it would
		// attribute a generated label to an analyst, and the log's whole value is
		// that everything in it was actually decided by someone.
		assert.ok(isPlaceholderName('sub_140001000'));
		assert.ok(isPlaceholderName('loc_1000'));
		assert.ok(!isPlaceholderName('decrypt_config'));
		assert.ok(!isPlaceholderName('sub_process_packet'), 'a real name may start with sub_');
	});
});
