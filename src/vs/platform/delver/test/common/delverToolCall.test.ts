/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { delverToolCallFromWire, delverToolCallToWire, IDelverToolCallRecord } from '../../common/delverToolCall.js';

const RECORD: IDelverToolCallRecord = {
	callId: 'call-1',
	capability: 'delver_disassemble',
	contentHash: 'a'.repeat(64),
	caller: { kind: 'model', id: 'model-a' },
	startedAt: 100,
	finishedAt: 120,
	requestJson: '{"address":"0x1000"}',
	resultJson: '{"callId":"call-1","data":{"instructions":[]}}',
};

suite('Delver tool-call records', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips a bounded model-visible dispatcher exchange', () => {
		assert.deepStrictEqual(delverToolCallFromWire(delverToolCallToWire(RECORD)), RECORD);
	});

	test('rejects invalid JSON and backwards timestamps', () => {
		assert.throws(() => delverToolCallFromWire({ ...RECORD, requestJson: '{' }), /request JSON/);
		assert.throws(() => delverToolCallFromWire({ ...RECORD, finishedAt: 99 }), /precedes/);
	});
});
