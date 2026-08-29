/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { shouldFollowWhilePinned } from '../../../../services/delver/browser/delverListingContext.js';
import { FocusReason } from '../../../../services/delver/common/delverFocusService.js';
import { parseAddress } from '../../browser/delverListingNavigation.js';
import { containingFunctionRva } from '../../../../services/delver/common/delverFunctions.js';

/** Mocha cannot serialize a BigInt, so failures print nothing useful without this. */
function show(value: bigint | undefined): string {
	return value === undefined ? '<invalid>' : `0x${value.toString(16)}`;
}

suite('Delver listing navigation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('bare digits are hex, matching what the listing displays', () => {
		// The listing shows 0x1000. Typing what you read has to land there —
		// reading this as decimal would navigate somewhere plausible and wrong.
		assert.strictEqual(show(parseAddress('1000')), '0x1000');
		assert.strictEqual(show(parseAddress('0x1000')), '0x1000');
		assert.strictEqual(show(parseAddress('0X1000')), '0x1000');
	});

	test('decimal needs saying so', () => {
		assert.strictEqual(show(parseAddress('0n4096')), '0x1000');
	});

	test('surrounding and embedded whitespace is ignored', () => {
		// Addresses get copied out of logs and dumps with all sorts of spacing.
		assert.strictEqual(show(parseAddress('  0x14000_1000  ')), '0x140001000');
		assert.strictEqual(show(parseAddress('1400 1000')), '0x14001000');
	});

	test('the full u64 range survives', () => {
		// The reason addresses are bigint at all: this truncates as a double.
		assert.strictEqual(show(parseAddress('0xFFFFFFFFFFFFFFFF')), '0xffffffffffffffff');
	});

	test('anything wider than u64 is a typo, not an address', () => {
		assert.strictEqual(show(parseAddress('0x1FFFFFFFFFFFFFFFF')), '<invalid>');
	});

	test('non-addresses are rejected rather than coerced', () => {
		for (const input of ['', '   ', 'ghij', '0x', '0n', '12g4', '-1', '0n0x10']) {
			assert.strictEqual(show(parseAddress(input)), '<invalid>', `input: "${input}"`);
		}
	});

	test('any instruction row inside a function resolves to its entry', () => {
		const functions = [
			{ rva: '0x1000', end_rva: '0x1010', authoritative: true, source: FunctionSourceWire.ExceptionDirectory },
			{ rva: '0x1020', end_rva: '0x1030', authoritative: true, source: FunctionSourceWire.ExceptionDirectory },
		];
		assert.strictEqual(containingFunctionRva(functions, 0x1000n), 0x1000n);
		assert.strictEqual(containingFunctionRva(functions, 0x100fn), 0x1000n);
		assert.strictEqual(containingFunctionRva(functions, 0x1010n), undefined);
		assert.strictEqual(containingFunctionRva(functions, 0x1028n), 0x1020n);
	});

	suite('pinning', () => {

		test('a pinned view still follows what the user just did', () => {
			// Go to Address, a clicked reference, Escape. Refusing these would
			// make pin feel broken rather than protective.
			assert.strictEqual(shouldFollowWhilePinned(FocusReason.User), true);
			assert.strictEqual(shouldFollowWhilePinned(FocusReason.Navigation), true);
		});

		test('a pinned view ignores movement the user did not cause', () => {
			// The whole point: an agent walking xrefs, a script, or a target
			// stopping must not move a view pinned to hold someone's place.
			for (const reason of [FocusReason.Ai, FocusReason.Script, FocusReason.TargetEvent]) {
				assert.strictEqual(shouldFollowWhilePinned(reason), false, `reason: ${reason}`);
			}
		});
	});
});
