/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { referenceAddressLabel } from '../../browser/delverXrefsView.js';

const functions: readonly IFunctionWire[] = [
	{ rva: '0x1000', end_rva: '0x1100', authoritative: true, source: FunctionSourceWire.ExceptionDirectory },
	{ rva: '0x2000', authoritative: false, source: FunctionSourceWire.LinearSweep },
];

suite('Delver references function-relative labels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an authored function name and offset inside a known range', () => {
		assert.strictEqual(
			referenceAddressLabel('0x102A', functions, new Map([[0x1000n, 'decrypt_config']])),
			'decrypt_config+0x2A',
		);
	});

	test('uses placeholders at exact entries and does not claim unknown gaps', () => {
		assert.strictEqual(referenceAddressLabel('0x2000', functions, new Map()), 'sub_2000');
		assert.strictEqual(referenceAddressLabel('0x2001', functions, new Map()), '0x2001');
		assert.strictEqual(referenceAddressLabel('0x1800', functions, new Map()), '0x1800');
	});
});
