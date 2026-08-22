/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DelverOverviewTreeDataProvider, DELVER_OVERVIEW_GO_TO_COMMAND, DELVER_OVERVIEW_REVEAL_COMMAND } from '../../browser/delverOverviewView.js';

suite('Delver overview navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('actionable rows preserve addresses and route to their workspace surfaces', async () => {
		const provider = new DelverOverviewTreeDataProvider();
		provider.setContent('C:\\samples\\wide.exe', {
			arch: 'x86_64',
			function_count: 12,
			image_id: 'image-1',
			instruction_count: 34_567,
			string_count: 89,
			xref_count: 123,
		}, {
			arch: 'x86_64',
			content_hash: 'hash',
			entry: '0x1000000000000001',
			export_count: 0,
			function_seed_count: 1,
			image_base: '0x1000000000000000',
			import_module_count: 0,
			import_symbol_count: 0,
			relocation_count: 0,
			sections: [],
		});

		const rows = await provider.getChildren();
		assert.deepStrictEqual(
			rows?.map(row => ({
				label: row.label?.label,
				description: row.description,
				command: row.command?.id,
				arguments: row.command?.arguments,
			})),
			[
				{ label: 'File', description: 'wide.exe', command: undefined, arguments: undefined },
				{ label: 'Architecture', description: 'x86_64', command: undefined, arguments: undefined },
				{ label: 'Entry point', description: '0x1000000000000001', command: DELVER_OVERVIEW_GO_TO_COMMAND, arguments: ['0x1000000000000001'] },
				{ label: 'Image base', description: '0x1000000000000000', command: undefined, arguments: undefined },
				{ label: 'Instructions', description: (34_567).toLocaleString(), command: 'delver.listing.openCurrent', arguments: [] },
				{ label: 'Functions', description: '12', command: DELVER_OVERVIEW_REVEAL_COMMAND, arguments: ['delver.view.functions'] },
				{ label: 'References', description: '123', command: DELVER_OVERVIEW_REVEAL_COMMAND, arguments: ['delver.view.xrefs'] },
				{ label: 'Strings', description: '89', command: 'delver.strings.open', arguments: [] },
			],
		);
	});
});
