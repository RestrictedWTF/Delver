/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { activeListing, IDelverListingHost, setActiveListing, touchActiveListing } from '../../../../services/delver/browser/delverActiveListing.js';

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

	test('focus decides which of two simultaneously visible listings wins', async () => {
		// Two side-by-side groups are both visible at once, so registration
		// order reflects which was *shown* last, not which is being looked at.
		// Clicking back into the first must retarget actions to it — otherwise
		// Follow and Generate Signature act on the other pane, silently.
		const left = host('1000');
		const right = host('2000');
		const leftRegistration = setActiveListing(left);
		const rightRegistration = setActiveListing(right);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		touchActiveListing(left);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		touchActiveListing(right);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		rightRegistration.dispose();
		leftRegistration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});

	test('focusing an unregistered host does not grant it membership', async () => {
		const registered = host('1000');
		const hidden = host('2000');
		const registration = setActiveListing(registered);

		touchActiveListing(hidden);

		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);
		registration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});

	test('re-registering a host that is already live leaves exactly one entry', async () => {
		// A host re-registers whenever its container is shown again, and
		// `MutableDisposable` pushes the new registration *before* disposing the
		// old one — so the stack transiently holds the same host twice. Nothing
		// in this module makes that safe on its own: it works only because
		// disposal removes the newest match. Pinning it here, because a change
		// to either half would otherwise strand a dead host at the top of the
		// stack and hand every listing action to a disposed widget.
		const only = host('1000');
		const first = setActiveListing(only);
		const second = setActiveListing(only);

		first.dispose();
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		second.dispose();
		assert.strictEqual(activeListing(), undefined);
	});
});
