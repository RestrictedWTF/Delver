/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire, IFunctionWire, IRangeWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { containingFunctionRva } from '../../common/delverFunctions.js';

function fn(rva: string, endRva: string | undefined, fragments?: IRangeWire[]): IFunctionWire {
	return {
		rva,
		end_rva: endRva,
		source: FunctionSourceWire.ExceptionDirectory,
		authoritative: true,
		fragments,
	};
}

suite('Delver containing function', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// These mirror `delver_analysis::call_graph::containing_function`. The two
	// answer the same question and must not disagree, so the cases are kept
	// deliberately parallel.

	test('an address inside a recorded extent belongs to that function', () => {
		const functions = [fn('0x1000', '0x1100'), fn('0x2000', '0x2100')];
		assert.deepStrictEqual(
			[
				containingFunctionRva(functions, 0x1000n),
				containingFunctionRva(functions, 0x10ffn),
				containingFunctionRva(functions, 0x2050n),
			],
			[0x1000n, 0x1000n, 0x2000n],
		);
	});

	test('padding after a function belongs to no function', () => {
		assert.strictEqual(containingFunctionRva([fn('0x1000', '0x1100')], 0x1100n), undefined);
	});

	test('an address in a cold piece belongs to the function it was split from', () => {
		// The piece sits outside the entry's extent by construction, and far
		// enough away that another function lies between.
		const functions = [
			fn('0x1000', '0x1100', [{ start: '0x9000', end: '0x9080' }]),
			fn('0x2000', '0x2100'),
		];
		assert.deepStrictEqual(
			[
				containingFunctionRva(functions, 0x9000n),
				containingFunctionRva(functions, 0x907fn),
				containingFunctionRva(functions, 0x9080n),
			],
			[0x1000n, 0x1000n, undefined],
		);
	});

	test('a function between the entry and its cold piece is not swallowed', () => {
		// The reason fragments are not folded into `end_rva`: stretching one
		// extent from 0x1000 to 0x9080 would take 0x2000 with it.
		const functions = [
			fn('0x1000', '0x1100', [{ start: '0x9000', end: '0x9080' }]),
			fn('0x2000', '0x2100'),
		];
		assert.strictEqual(containingFunctionRva(functions, 0x2050n), 0x2000n);
	});

	test('a function with no fragments field behaves as one with none', () => {
		// The wire omits the array when it is empty, so `undefined` is the
		// common case and must not be read as a missing answer.
		assert.strictEqual(containingFunctionRva([fn('0x1000', '0x1100')], 0x9000n), undefined);
	});

	test('an address below every entry belongs to no function', () => {
		assert.strictEqual(containingFunctionRva([fn('0x1000', '0x1100')], 0x900n), undefined);
	});

	test('a function with no recorded end still claims addresses after it', () => {
		assert.strictEqual(containingFunctionRva([fn('0x1000', undefined)], 0x5000n), 0x1000n);
	});
});
