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
	placeholderUnrecoveredFunctionName,
} from '../../common/naming.js';

suite('Delver naming', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('placeholders match the convention analysts already type', () => {
		// Bare uppercase hex, no 0x — these get pasted into notes and tickets,
		// and must be recognisable to anyone coming from IDA.
		assert.deepStrictEqual(
			[placeholderFunctionName(0x140001000n), placeholderLocationName(0x1000n)],
			['SUB_140001000', 'loc_1000'],
		);
	});

	test('a called address with no recovered function is neither a sub nor a loc', () => {
		// Three distinct claims: an entry nobody named, a label inside one, and
		// an address something calls where no function was recovered at all.
		assert.deepStrictEqual(
			[
				placeholderFunctionName(0x1d7a0n),
				placeholderLocationName(0x1d7a0n),
				placeholderUnrecoveredFunctionName(0x1d7a0n),
			],
			['SUB_1D7A0', 'loc_1D7A0', 'UNDEF_1D7A0'],
		);
	});

	test('every generated spelling reads as a placeholder, so none is logged as authored', () => {
		assert.deepStrictEqual(
			[
				isPlaceholderName(placeholderFunctionName(0x1000n)),
				isPlaceholderName(placeholderLocationName(0x1000n)),
				isPlaceholderName(placeholderUnrecoveredFunctionName(0x1000n)),
				isPlaceholderName('sub_1000'),
				isPlaceholderName('decrypt_config'),
				isPlaceholderName('UNDEFINED_BEHAVIOUR'),
			],
			[true, true, true, true, false, false],
		);
	});

	test('the full u64 range survives', () => {
		assert.strictEqual(
			placeholderFunctionName(0xFFFFFFFFFFFFFFFFn),
			'SUB_FFFFFFFFFFFFFFFF',
		);
	});

	test('an authored name wins over the placeholder', () => {
		assert.strictEqual(functionDisplayName(0x1000n, 'decrypt_config'), 'decrypt_config');
	});

	test('clearing a name restores the placeholder rather than blanking the row', () => {
		assert.deepStrictEqual(
			[functionDisplayName(0x1000n, undefined), functionDisplayName(0x1000n, '')],
			['SUB_1000', 'SUB_1000'],
		);
	});

	test('a placeholder is recognisable as one', () => {
		// Nothing may write a placeholder into the interpretation log: it would
		// attribute a generated label to an analyst, and the log's whole value is
		// that everything in it was actually decided by someone.
		assert.ok(isPlaceholderName('SUB_1000'));
		assert.ok(isPlaceholderName('sub_140001000'), 'legacy project placeholders remain generated names');
		assert.ok(isPlaceholderName('loc_1000'));
		assert.ok(!isPlaceholderName('decrypt_config'));
		assert.ok(!isPlaceholderName('sub_process_packet'), 'a real name may start with sub_');
	});
});
