/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDecompiledFunction } from '../../../../services/delver/common/delverDecompilerService.js';
import { focusForPseudocodeLine, pseudocodeLineForRva } from '../../browser/delverPseudocodeModel.js';

const result: IDecompiledFunction = {
	backendId: 'test',
	functionRva: 0x1000n,
	text: 'int entry(void) {\n\treturn 0;\n}',
	lineMappings: [
		{ line: 2, ranges: [{ startRva: 0x1010n, endRva: 0x1014n }, { startRva: 0x1000n, endRva: 0x1004n }] },
		{ line: 2, ranges: [{ startRva: 0x1020n, endRva: 0x1022n }] },
		{ line: 4, ranges: [{ startRva: 0x1002n, endRva: 0x1008n }] },
	],
	variables: [],
};

suite('DelverPseudocodeModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps a line to its first instruction and bounding selection', () => {
		assert.deepStrictEqual(focusForPseudocodeLine(result, 2), {
			address: 0x1000n,
			selection: { start: 0x1000n, end: 0x1022n },
		});
		assert.strictEqual(focusForPseudocodeLine(result, 3), undefined);
	});

	test('maps an address to the first matching line', () => {
		assert.strictEqual(pseudocodeLineForRva(result, 0x1002n), 2);
		assert.strictEqual(pseudocodeLineForRva(result, 0x1012n), 2);
		assert.strictEqual(pseudocodeLineForRva(result, 0x2000n), undefined);
	});
});
