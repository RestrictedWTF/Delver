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
			modules: [
				{
					name: 'KERNEL32.dll', symbols: [
						{ name: 'CreateFileW', iat_rva: '0x3000' },
						{ name: 'ReadFile', iat_rva: '0x3008' },
					]
				},
				{ name: 'WS2_32.dll', symbols: [{ ordinal: 7, iat_rva: '0x4000' }] },
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
});
