/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TreeItemCollapsibleState } from '../../../../common/views.js';
import { DelverImportsTreeDataProvider } from '../../browser/delverImportsView.js';

suite('Delver imports filtering', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches module names and symbol fields while preserving original RVAs', async () => {
		const provider = new DelverImportsTreeDataProvider();
		provider.setImports({
			failed: false,
			module_total: 2,
			truncated: false,
			modules: [
				{
					name: 'KERNEL32.dll', symbols: [
						{ name: 'CreateFileW', iat_rva: '0x3000', name_unreadable: false },
						{ name: 'ReadFile', iat_rva: '0x3008', name_unreadable: false },
					], name_unreadable: false, symbols_failed: false, symbols_truncated: false
				},
				{ name: 'WS2_32.dll', symbols: [{ ordinal: 7, iat_rva: '0x4000', name_unreadable: false }], name_unreadable: false, symbols_failed: false, symbols_truncated: false },
			]
		});

		provider.setFilter('readfile');
		let modules = await provider.getChildren();
		let symbols = await provider.getChildren(modules![0]);
		assert.deepStrictEqual(
			{
				modules: modules?.map(item => item.label?.label),
				state: modules![0].collapsibleState,
				symbols: symbols?.map(item => ({ label: item.label?.label, description: item.description })),
			},
			{
				modules: ['KERNEL32.dll'],
				state: TreeItemCollapsibleState.Expanded,
				symbols: [{ label: 'ReadFile', description: '0x3008' }],
			},
		);

		provider.setFilter('ws2');
		modules = await provider.getChildren();
		symbols = await provider.getChildren(modules![0]);
		assert.strictEqual(symbols?.[0].description, '0x4000');
	});

	test('clearing a filter after zero matches restores the imports', async () => {
		const provider = new DelverImportsTreeDataProvider();
		provider.setImports({
			failed: false,
			module_total: 1,
			truncated: false,
			modules: [{ name: 'KERNEL32.dll', symbols: [{ name: 'CreateFileW', iat_rva: '0x3000', name_unreadable: false }], name_unreadable: false, symbols_failed: false, symbols_truncated: false }],
		});

		provider.setFilter('does-not-exist');
		assert.deepStrictEqual({ isFiltered: provider.isFiltered, rows: await provider.getChildren() }, { isFiltered: true, rows: [] });

		provider.setFilter('');
		assert.deepStrictEqual(
			{ isFiltered: provider.isFiltered, labels: (await provider.getChildren())?.map(item => item.label?.label) },
			{ isFiltered: false, labels: ['KERNEL32.dll'] },
		);
	});

	test('filtered modules do not share expansion identity with normal modules', async () => {
		const provider = new DelverImportsTreeDataProvider();
		provider.setImports({
			failed: false,
			module_total: 1,
			truncated: false,
			modules: [{ name: 'KERNEL32.dll', symbols: [{ name: 'CreateFileW', iat_rva: '0x3000', name_unreadable: false }], name_unreadable: false, symbols_failed: false, symbols_truncated: false }],
		});
		const normal = (await provider.getChildren())![0];

		provider.setFilter('kernel');
		const filtered = (await provider.getChildren())![0];

		assert.deepStrictEqual(
			{ normal: { handle: normal.handle, state: normal.collapsibleState }, filtered: { handle: filtered.handle, state: filtered.collapsibleState } },
			{
				normal: { handle: 'delver.import.module.0', state: TreeItemCollapsibleState.Collapsed },
				filtered: { handle: 'delver.import.filtered.module.0', state: TreeItemCollapsibleState.Expanded },
			},
		);
	});
});
