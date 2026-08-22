/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { IDtpConnectionTransport } from '../connection';
import { IRelayAttempt } from '../relayProcess';
import { DelverAgentRelaySupervisor, waitForRelayReady } from '../relaySupervisor';
import { TestRelayProcess, TestRelayTimers } from './relayTestUtils';

const READY = '{"event":"ready","schemaVersion":1}\n';

class TestConnection {
	readonly data: string[] = [];
	readonly disposeCalls: boolean[] = [];
	private readonly removeCloseListener: () => void;
	private disposed = false;

	constructor(private readonly transport: IDtpConnectionTransport) {
		this.transport.onData(data => this.data.push(data.toString()));
		this.removeCloseListener = transport.onClose(() => this.dispose(false));
	}

	dispose(closeTransport = true): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.disposeCalls.push(closeTransport);
		this.removeCloseListener();
		if (closeTransport) {
			this.transport.close();
		}
	}
}

describe('Delver relay readiness', () => {
	it('accepts one fragmented exact JSON line and CRLF', async () => {
		for (const suffix of ['\n', '\r\n']) {
			const process = new TestRelayProcess();
			const timers = new TestRelayTimers();
			const ready = waitForRelayReady(process, timers, 5_000);
			process.emitStderr('{"event":"rea');
			process.emitStderr(`dy","schemaVersion":1}${suffix}`);
			await ready;
			assert.deepStrictEqual(timers.pendingDelays(), []);
		}
	});

	it('rejects malformed, extended, prefixed, and oversized readiness', async () => {
		for (const record of [
			'{"event":"ready"}\n',
			'{"event":"ready","schemaVersion":1,"extra":true}\n',
			'diagnostic\n',
			`${READY}extra`,
			'a'.repeat(4 * 1024 + 1),
		]) {
			const process = new TestRelayProcess();
			const ready = waitForRelayReady(process, new TestRelayTimers(), 5_000);
			process.emitStderr(record);
			await assert.rejects(ready, /readiness/);
		}
	});

	it('rejects timeout and exit before readiness', async () => {
		const timeoutProcess = new TestRelayProcess();
		const timeoutTimers = new TestRelayTimers();
		const timedOut = waitForRelayReady(timeoutProcess, timeoutTimers, 50);
		timeoutTimers.runDelay(50);
		await assert.rejects(timedOut, /timed out/);

		const exitedProcess = new TestRelayProcess();
		const exited = waitForRelayReady(exitedProcess, new TestRelayTimers(), 50);
		exitedProcess.emitExit(1);
		await assert.rejects(exited, /exited before readiness/);
	});
});

describe('Delver relay supervision', () => {
	it('keeps stdout protocol-only and rotates credentials after a crash', async () => {
		const fixture = createSupervisorFixture();
		const started = fixture.supervisor.start();
		fixture.processes[0].emitStdout('dtp-before-ready');
		fixture.processes[0].emitStderr(READY);
		await started;

		assert.deepStrictEqual({
			spawn: fixture.spawnCalls[0],
			spawnContainsToken: JSON.stringify(fixture.spawnCalls[0]).includes('token-1'),
			connectionToken: fixture.connectionTokens[0],
			stdout: fixture.connections[0].data,
		}, {
			spawn: { executable: 'C:\\Delver\\delver-agent-relay.exe', endpoint: 'pipe://attempt-1' },
			spawnContainsToken: false,
			connectionToken: 'token-1',
			stdout: ['dtp-before-ready'],
		});

		fixture.processes[0].emitError();
		fixture.processes[0].emitExit(1);
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [100]);
		fixture.timers.runDelay(100);

		assert.deepStrictEqual({
			spawn: fixture.spawnCalls[1],
			connectionToken: fixture.connectionTokens[1],
			firstCleanup: fixture.cleanupCounts[0],
		}, {
			spawn: { executable: 'C:\\Delver\\delver-agent-relay.exe', endpoint: 'pipe://attempt-2' },
			connectionToken: 'token-2',
			firstCleanup: 1,
		});
		fixture.supervisor.dispose();
	});

	it('retries malformed readiness and resolves start on a later attempt', async () => {
		const fixture = createSupervisorFixture();
		const started = fixture.supervisor.start();
		fixture.processes[0].emitStderr('{"event":"wrong","schemaVersion":1}\n');
		await settlePromises();
		assert.deepStrictEqual({ terminated: fixture.processes[0].terminateCount, delays: fixture.timers.pendingDelays() }, {
			terminated: 1,
			delays: [100],
		});

		fixture.timers.runDelay(100);
		fixture.processes[1].emitStderr(READY);
		await started;
		fixture.supervisor.dispose();
	});

	it('increases crash backoff until a stable lifetime resets it', async () => {
		const fixture = createSupervisorFixture();
		const started = fixture.supervisor.start();
		fixture.processes[0].emitStderr(READY);
		await started;
		fixture.processes[0].emitError();
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [100]);

		fixture.timers.runDelay(100);
		fixture.processes[1].emitStderr(READY);
		await settlePromises();
		fixture.processes[1].emitError();
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [250]);

		fixture.timers.runDelay(250);
		fixture.processes[2].emitStderr(READY);
		await settlePromises();
		fixture.timers.runDelay(30_000);
		fixture.processes[2].emitError();
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [100]);
		fixture.supervisor.dispose();
	});

	it('disposal kills and cleans a pending attempt without respawning', async () => {
		const fixture = createSupervisorFixture();
		const started = fixture.supervisor.start();
		const rejected = assert.rejects(started, /disposed before becoming ready/);
		fixture.supervisor.dispose();
		await rejected;

		assert.deepStrictEqual({
			terminations: fixture.processes[0].terminateCount,
			cleanup: fixture.cleanupCounts[0],
			timers: fixture.timers.pendingDelays(),
			attempts: fixture.processes.length,
		}, {
			terminations: 1,
			cleanup: 1,
			timers: [],
			attempts: 1,
		});
	});
});

function createSupervisorFixture() {
	const timers = new TestRelayTimers();
	const processes: TestRelayProcess[] = [];
	const spawnCalls: { readonly executable: string; readonly endpoint: string }[] = [];
	const connections: TestConnection[] = [];
	const connectionTokens: string[] = [];
	const cleanupCounts: number[] = [];
	let attemptNumber = 0;
	const createAttempt = (): IRelayAttempt => {
		const index = attemptNumber++;
		cleanupCounts[index] = 0;
		return {
			endpoint: `pipe://attempt-${index + 1}`,
			token: `token-${index + 1}`,
			cleanup: async () => {
				cleanupCounts[index]++;
			},
		};
	};
	const supervisor = new DelverAgentRelaySupervisor({
		executable: 'C:\\Delver\\delver-agent-relay.exe',
		spawn: (executable, endpoint) => {
			spawnCalls.push({ executable, endpoint });
			const process = new TestRelayProcess();
			processes.push(process);
			return process;
		},
		createAttempt,
		createConnection: (transport, token) => {
			connectionTokens.push(token);
			const connection = new TestConnection(transport);
			connections.push(connection);
			return connection;
		},
		timers,
	});
	return { supervisor, timers, processes, spawnCalls, connections, connectionTokens, cleanupCounts };
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
