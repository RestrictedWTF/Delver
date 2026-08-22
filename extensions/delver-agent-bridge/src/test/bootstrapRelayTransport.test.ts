/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { GatedBootstrapRelayTransport } from '../bootstrapRelayTransport';
import { TestRelayProcess } from './relayTestUtils';

describe('Bootstrap relay transport', () => {
	it('replays buffered fragments once in order before forwarding live data', () => {
		const process = new TestRelayProcess();
		const transport = new GatedBootstrapRelayTransport(process, 16);
		const data: string[] = [];
		process.emitStdout('first');
		process.emitStdout('-second');
		transport.onData(chunk => data.push(chunk.toString()));

		transport.release();
		process.emitStdout('-live');

		assert.deepStrictEqual(data, ['first', '-second', '-live']);
		transport.terminate();
	});

	it('accepts the exact input bound and terminates before buffering one byte more', () => {
		const exactProcess = new TestRelayProcess();
		const exact = new GatedBootstrapRelayTransport(exactProcess, 5);
		const exactData: string[] = [];
		exactProcess.emitStdout('12345');
		exact.onData(data => exactData.push(data.toString()));
		exact.release();

		const overflowProcess = new TestRelayProcess();
		const overflow = new GatedBootstrapRelayTransport(overflowProcess, 5);
		let closes = 0;
		overflow.onClose(() => closes++);
		overflowProcess.emitStdout('123');
		overflowProcess.emitStdout('456');

		assert.deepStrictEqual({ exactData, exactTerminations: exactProcess.terminateCount, overflowTerminations: overflowProcess.terminateCount, closes }, {
			exactData: ['12345'],
			exactTerminations: 0,
			overflowTerminations: 1,
			closes: 1,
		});
		exact.terminate();
	});

	it('settles response writes only after callback and backpressure drain', async () => {
		const process = new TestRelayProcess();
		process.writeResults.push(false);
		const transport = new GatedBootstrapRelayTransport(process);
		let settled = false;
		const write = transport.write(Buffer.from('credential')).then(() => settled = true);
		process.writes[0].callback();
		await Promise.resolve();
		assert.strictEqual(settled, false);

		process.emitDrain();
		await write;
		assert.strictEqual(settled, true);

		const failedProcess = new TestRelayProcess();
		const failed = new GatedBootstrapRelayTransport(failedProcess);
		const failedWrite = failed.write(Buffer.from('credential'));
		failedProcess.writes[0].callback(new Error('broken pipe'));
		await assert.rejects(failedWrite, /broken pipe/);
		transport.terminate();
	});
});
