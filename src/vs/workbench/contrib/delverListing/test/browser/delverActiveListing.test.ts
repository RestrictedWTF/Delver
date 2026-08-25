/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { activeListing, IDelverListingHost, setActiveListing } from '../../browser/delverActiveListing.js';

function host(name: string): IDelverListingHost {
	return {
		togglePin: () => { },
		followSelection: () => { },
		selectedFunctionRva: async () => BigInt(`0x${name}`),
	};
}

suite('Delver active listing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports nothing before anything registers', () => {
		assert.strictEqual(activeListing(), undefined);
	});

	test('the most recently focused host wins, and disposing it restores the previous one', async () => {
		const first = host('1000');
		const second = host('2000');

		const firstRegistration = setActiveListing(first);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		const secondRegistration = setActiveListing(second);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		secondRegistration.dispose();
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		firstRegistration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});

	test('disposing a host that is not on top does not change the active one', async () => {
		const first = host('1000');
		const second = host('2000');
		const firstRegistration = setActiveListing(first);
		const secondRegistration = setActiveListing(second);

		firstRegistration.dispose();
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		secondRegistration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});
});
