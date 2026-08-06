/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DelverProviderProcess } from '../../node/providerProcess.js';
import { TargetCapability } from '../../common/capabilities.js';

suite('DelverProviderProcess', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('spawns provider-file and receives initialize', async function () {
		// This test requires a PE file. Point it at any small PE on the system,
		// or skip when DELVER_TEST_PE is not set.
		const testPe = process.env.DELVER_TEST_PE;
		if (!testPe) {
			this.skip();
		}

		const target = await DelverProviderProcess.attach({ kind: 'file', path: testPe });
		try {
			assert.strictEqual(target.descriptor.kind, 'file');
			assert.ok(target.capabilities.includes(TargetCapability.ListSpaces));
			assert.ok(target.capabilities.includes(TargetCapability.GetImageInfo));
			assert.ok(target.capabilities.includes(TargetCapability.ReadMemory));

			const spaces = await target.listSpaces();
			assert.ok(spaces.length >= 2);
			assert.ok(spaces.some(s => s.id === 'File'));
			assert.ok(spaces.some(s => s.id === 'Image'));
		} finally {
			target.dispose();
		}
	});
});
