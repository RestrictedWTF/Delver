/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decodeGhidraDecompilerOutput, DelverDecompilerOutputError } from '../../common/ghidraDecompilerProtocol.js';

suite('GhidraDecompilerProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes the versioned wire format without losing RVA precision', () => {
		const result = decodeGhidraDecompilerOutput(JSON.stringify({
			schemaVersion: 1,
			functionRva: '0x20000000000001',
			text: 'int entry(void) {\n\treturn 0;\n}',
			lineMappings: [{
				line: 2,
				ranges: [
					{ startRva: '0x20000000000001', endRva: '0x20000000000005' },
					{ startRva: '0x20000000000010', endRva: '0x20000000000012' },
				],
			}],
			variables: [{ name: 'result', typeName: 'int', storage: 'RAX', declarationLine: 1 }],
		}), 0x20000000000001n);

		assert.deepStrictEqual(result, {
			backendId: 'ghidra-headless',
			functionRva: 0x20000000000001n,
			text: 'int entry(void) {\n\treturn 0;\n}',
			lineMappings: [{
				line: 2,
				ranges: [
					{ startRva: 0x20000000000001n, endRva: 0x20000000000005n },
					{ startRva: 0x20000000000010n, endRva: 0x20000000000012n },
				],
			}],
			variables: [{ name: 'result', typeName: 'int', storage: 'RAX', declarationLine: 1 }],
		});
	});

	test('rejects malformed and incompatible responses', () => {
		const responses = [
			'not json',
			JSON.stringify({ schemaVersion: 2, functionRva: '0x1000', text: '', lineMappings: [], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '1000', text: '', lineMappings: [], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [], extra: true }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [{ line: 0, ranges: [] }], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [{ line: 1, ranges: [{ startRva: '0x20', endRva: '0x20' }] }], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [{ name: '' }] }),
		];

		for (const response of responses) {
			assert.throws(() => decodeGhidraDecompilerOutput(response, 0x1000n), DelverDecompilerOutputError);
		}
	});

	test('rejects output for a different function', () => {
		assert.throws(
			() => decodeGhidraDecompilerOutput(JSON.stringify({
				schemaVersion: 1,
				functionRva: '0x1001',
				text: '',
				lineMappings: [],
				variables: [],
			}), 0x1000n),
			DelverDecompilerOutputError,
		);
	});
});
