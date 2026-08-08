/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { DelverFunctionsTreeDataProvider, functionRvaFromHandle } from '../../browser/delverFunctionsView.js';

suite('DelverFunctionsTreeDataProvider interpretation actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('function rows carry their wire-safe RVA in an actionable handle', async () => {
		const provider = new DelverFunctionsTreeDataProvider();
		provider.setFunctions([{
			authoritative: true,
			rva: '0x1000000000000001',
			source: FunctionSourceWire.EntryPoint,
		}]);
		provider.setNames(new Map([['0x1000000000000001', 'entry']]));
		const groups = await provider.getChildren();
		const rows = await provider.getChildren(groups![0]);

		assert.deepStrictEqual(
			{
				handle: rows![0].handle,
				contextValue: rows![0].contextValue,
				label: rows![0].label,
				rva: functionRvaFromHandle(rows![0].handle),
			},
			{
				handle: 'delver.function.0x1000000000000001',
				contextValue: 'delver-function',
				label: { label: 'entry' },
				rva: 0x1000000000000001n,
			},
		);
	});
});
