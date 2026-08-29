/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Readable, Writable } from 'stream';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ErrorKind, IResponse } from '../../common/protocol.generated.js';
import { DelverRpcClient, DelverRpcError } from '../../node/rpc.js';

suite('DelverRpcClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects error envelopes without consuming response frames', async () => {
		const reader = Readable.from([
			frame({
				id: 1,
				error: {
					code: -32000,
					message: 'InvalidAddress',
					data: { kind: ErrorKind.InvalidAddress, detail: 'the function has no bounded extent' },
				},
			}),
			frame({ id: 2, result: { ready: true } }),
		]);
		const writer = new Writable({ write: (_chunk, _encoding, callback) => callback() });
		const client = new DelverRpcClient({ reader, writer });

		await assert.rejects(client.call('analysis/basicBlocks', {}, 1), error => {
			assert.ok(error instanceof DelverRpcError);
			assert.deepStrictEqual({
				name: error.name,
				message: error.message,
				code: error.code,
				data: error.data,
			}, {
				name: 'DelverRpcError',
				message: 'InvalidAddress: the function has no bounded extent',
				code: -32000,
				data: { kind: ErrorKind.InvalidAddress, detail: 'the function has no bounded extent' },
			});
			return true;
		});

		assert.deepStrictEqual((await client.call('initialize', null)).json.result, { ready: true });
	});

	test('fails the connection on an out-of-step reply instead of answering later calls from it', async () => {
		const reader = Readable.from([
			frame({ id: 7, result: { ready: true } }),
			frame({ id: 2, result: { ready: true } }),
		]);
		const writer = new Writable({ write: (_chunk, _encoding, callback) => callback() });
		const client = new DelverRpcClient({ reader, writer });

		await assert.rejects(client.call('initialize', null), /desynchronized: RPC id mismatch: expected 1, got 7/);
		await assert.rejects(client.call('analysis/functions', {}), /desynchronized: RPC id mismatch: expected 1, got 7/);
	});

	test('rejects an unparsable Content-Length instead of reading zero bytes', async () => {
		const body = Buffer.from(JSON.stringify({ id: 1, result: { ready: true } }), 'utf8');
		const reader = Readable.from([Buffer.concat([Buffer.from('Delver-Frame: 1\r\n\r\n', 'ascii'), body])]);
		const writer = new Writable({ write: (_chunk, _encoding, callback) => callback() });
		const client = new DelverRpcClient({ reader, writer });

		await assert.rejects(client.call('initialize', null), /Malformed Content-Length header: absent/);
	});
});

function frame(response: IResponse): Buffer {
	const body = Buffer.from(JSON.stringify(response), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'), body]);
}
