/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { IDelverAgentGateway } from '../connection';
import { DelverDtpRelayProvisioner } from '../dtpProvision';
import { encodeDtpMessage } from '../protocol';
import { IBootstrapRelayAttempt } from '../relayProcess';
import { DtpTokenLeaseStore } from '../tokenLease';
import { TestRelayProcess, TestRelayTimers } from './relayTestUtils';

const READY = '{"event":"ready","schemaVersion":1}\n';

describe('Private DTP relay provisioner', () => {
	it('returns only after readiness and closeAll awaits endpoint cleanup', async () => {
		const fixture = createFixture();
		let ready = false;
		const pending = fixture.provisioner.provision(new AbortController().signal).then(provision => {
			ready = true;
			return provision;
		});
		await settlePromises();
		assert.strictEqual(ready, false);

		fixture.processes[0].emitStderr(READY);
		const provision = await pending;
		const closed = fixture.provisioner.closeAll();
		assert.deepStrictEqual({ endpoint: provision.endpoint, terminations: fixture.processes[0].terminateCount, cleanup: fixture.cleanupCounts[0] }, {
			endpoint: 'pipe://private-1',
			terminations: 1,
			cleanup: 0,
		});
		fixture.processes[0].emitExit(0);
		await closed;
		assert.strictEqual(fixture.cleanupCounts[0], 1);
		await fixture.provisioner.dispose();
	});

	it('aborts a pending READY wait and rejects creates during root teardown', async () => {
		const fixture = createFixture();
		const controller = new AbortController();
		const pending = fixture.provisioner.provision(controller.signal);
		controller.abort();
		const closed = fixture.provisioner.closeAll();
		await assert.rejects(fixture.provisioner.provision(new AbortController().signal), /cancelled/);
		fixture.processes[0].emitExit(1);
		await Promise.all([assert.rejects(pending), closed]);
		assert.deepStrictEqual({ terminations: fixture.processes[0].terminateCount, cleanup: fixture.cleanupCounts[0], timers: fixture.timers.pendingDelays() }, {
			terminations: 1,
			cleanup: 1,
			timers: [],
		});
		await fixture.provisioner.dispose();
	});

	it('treats a child-process error as terminal when no exit event can follow', async () => {
		const fixture = createFixture();
		const pending = fixture.provisioner.provision(new AbortController().signal);
		fixture.processes[0].emitError(new Error('spawn failed'));
		await assert.rejects(pending);
		assert.deepStrictEqual({ cleanup: fixture.cleanupCounts[0], terminations: fixture.processes[0].terminateCount }, {
			cleanup: 1,
			terminations: 1,
		});
		await fixture.provisioner.dispose();
	});

	it('cancels active gateway work when the root closes', async () => {
		const fixture = createFixture();
		const pending = fixture.provisioner.provision(new AbortController().signal);
		fixture.processes[0].emitStderr(READY);
		const provision = await pending;
		const lease = fixture.leases.issue(provision.endpointGeneration);
		fixture.processes[0].emitStdout(encodeDtpMessage({
			id: 1,
			method: 'initialize',
			params: { protocolVersion: 1, token: lease.token, clientId: 'root-scope-test' },
		}));
		await settlePromises();
		fixture.processes[0].emitStdout(encodeDtpMessage({ id: 2, method: 'agent/invoke', params: { capability: 'session.info' } }));
		await settlePromises();

		const closed = fixture.provisioner.closeAll();
		fixture.processes[0].emitExit(0);
		await closed;
		assert.deepStrictEqual({ invocations: fixture.gateway.invocations.length, cancellations: fixture.gateway.cancellations }, {
			invocations: 1,
			cancellations: [fixture.gateway.invocations[0].requestId],
		});
		await fixture.provisioner.dispose();
	});
});

function createFixture() {
	const leases = new DtpTokenLeaseStore();
	const gateway = new TestGateway();
	const timers = new TestRelayTimers();
	const processes: TestRelayProcess[] = [];
	const cleanupCounts: number[] = [];
	let attemptNumber = 0;
	const provisioner = new DelverDtpRelayProvisioner({
		executable: 'C:\\Delver\\delver-agent-relay.exe',
		leases,
		gateway,
		timers,
		createEndpointGeneration: () => `generation-${attemptNumber}`,
		createAttempt: (): IBootstrapRelayAttempt => {
			const index = attemptNumber++;
			cleanupCounts[index] = 0;
			return {
				endpoint: `pipe://private-${index + 1}`,
				cleanup: async () => { cleanupCounts[index]++; },
			};
		},
		spawn: () => {
			const process = new TestRelayProcess();
			processes.push(process);
			return process;
		},
	});
	return { provisioner, leases, gateway, timers, processes, cleanupCounts };
}

class TestGateway implements IDelverAgentGateway {
	readonly invocations: { readonly requestId: string }[] = [];
	readonly cancellations: string[] = [];

	async capabilities(): Promise<unknown> {
		return {};
	}

	invoke(requestId: string): Promise<unknown> {
		this.invocations.push({ requestId });
		return new Promise(() => { });
	}

	async cancel(requestId: string): Promise<void> {
		this.cancellations.push(requestId);
	}
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
