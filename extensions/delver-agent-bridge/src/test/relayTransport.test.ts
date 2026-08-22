/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { RelayProcessTransport } from '../relayTransport';
import { TestRelayProcess } from './relayTestUtils';

describe('Delver relay transport', () => {
	it('serializes writes until callback and backpressure drain complete', () => {
		const process = new TestRelayProcess();
		process.writeResults.push(false, true);
		const transport = new RelayProcessTransport(process);

		transport.write(Buffer.from('first'));
		transport.write(Buffer.from('second'));
		process.writes[0].callback();
		assert.deepStrictEqual(process.writes.map(write => write.data.toString()), ['first']);

		process.emitDrain();
		assert.deepStrictEqual(process.writes.map(write => write.data.toString()), ['first', 'second']);
		process.writes[1].callback();
		transport.close();
		assert.deepStrictEqual({ endCount: process.endCount, terminateCount: process.terminateCount }, { endCount: 1, terminateCount: 0 });
	});

	it('forwards stdout as data and closes once on process failure', () => {
		const process = new TestRelayProcess();
		const transport = new RelayProcessTransport(process);
		const data: string[] = [];
		let closes = 0;
		transport.onData(chunk => data.push(chunk.toString()));
		transport.onClose(() => closes++);

		process.emitStdout('{"protocol":"bytes"}');
		process.emitError();
		process.emitExit(1);

		assert.deepStrictEqual({ data, closes, terminateCount: process.terminateCount }, {
			data: ['{"protocol":"bytes"}'],
			closes: 1,
			terminateCount: 1,
		});
	});

	it('closes on queue overflow and write callback failure', () => {
		const overflowProcess = new TestRelayProcess();
		overflowProcess.writeResults.push(false);
		const overflow = new RelayProcessTransport(overflowProcess, 3);
		overflow.write(Buffer.from('ab'));
		assert.throws(() => overflow.write(Buffer.from('cd')), /write queue is full/);

		const failedProcess = new TestRelayProcess();
		const failed = new RelayProcessTransport(failedProcess);
		failed.write(Buffer.from('request'));
		failedProcess.writes[0].callback(new Error('broken pipe'));

		assert.deepStrictEqual({
			overflowTerminations: overflowProcess.terminateCount,
			failedTerminations: failedProcess.terminateCount,
		}, {
			overflowTerminations: 1,
			failedTerminations: 1,
		});
	});
});
