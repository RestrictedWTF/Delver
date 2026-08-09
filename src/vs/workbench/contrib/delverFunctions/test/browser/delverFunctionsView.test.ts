/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { DelverFunctionsTreeDataProvider, FUNCTION_PAGE_SIZE, functionRvaFromHandle } from '../../browser/delverFunctionsView.js';

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

	test('all swept functions remain reachable through bounded lazy pages', async () => {
		const provider = new DelverFunctionsTreeDataProvider();
		provider.setFunctions(Array.from({ length: FUNCTION_PAGE_SIZE * 2 + 17 }, (_, index) => ({
			authoritative: false,
			rva: `0x${(0x1000 + index).toString(16)}`,
			source: FunctionSourceWire.LinearSweep,
		})));
		const groups = await provider.getChildren();
		const pages = await provider.getChildren(groups![1]);
		const lastPage = await provider.getChildren(pages![2]);

		assert.deepStrictEqual(
			{ pages: pages?.length, lastPage: lastPage?.length, last: lastPage?.at(-1)?.handle },
			{ pages: 3, lastPage: 17, last: `delver.function.0x${(0x1000 + FUNCTION_PAGE_SIZE * 2 + 16).toString(16)}` },
		);
	});

	test('filter searches authored names across the complete function set', async () => {
		const provider = new DelverFunctionsTreeDataProvider();
		const functions = Array.from({ length: FUNCTION_PAGE_SIZE + 1 }, (_, index) => ({
			authoritative: false,
			rva: `0x${(0x2000 + index).toString(16)}`,
			source: FunctionSourceWire.LinearSweep,
		}));
		provider.setFunctions(functions);
		provider.setNames(new Map([[functions.at(-1)!.rva, 'needle_handler']]));
		provider.setFilter('needle');
		const groups = await provider.getChildren();
		const matches = await provider.getChildren(groups![1]);

		assert.deepStrictEqual(
			{ count: groups![1].description, labels: matches?.map(item => item.label?.label) },
			{ count: '1', labels: ['needle_handler'] },
		);
	});

	test('filter recognizes the displayed function source', async () => {
		const provider = new DelverFunctionsTreeDataProvider();
		provider.setFunctions([{
			authoritative: false,
			rva: '0x3000',
			source: FunctionSourceWire.LinearSweep,
		}]);
		provider.setFilter('guess');
		const groups = await provider.getChildren();
		const matches = await provider.getChildren(groups![1]);

		assert.strictEqual(matches?.[0].handle, 'delver.function.0x3000');
	});
});
