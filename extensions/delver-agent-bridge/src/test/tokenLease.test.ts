/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { DelverDtpConnection, IDelverAgentGateway, IDtpConnectionTransport } from '../connection';
import { DtpErrorCode, DtpFrameDecoder, encodeDtpMessage, IDtpResponse } from '../protocol';
import { DtpTokenLeaseStore } from '../tokenLease';
import { TestRelayTimers } from './relayTestUtils';

describe('DTP token leases', () => {
	it('issues one memory-only 256-bit lease and rotates after revoke', () => {
		const timers = new TestRelayTimers();
		let tokenByte = 1;
		let leaseNumber = 1;
		const store = new DtpTokenLeaseStore({
			timers,
			now: () => 1_000,
			createTokenBytes: size => Buffer.alloc(size, tokenByte++),
			createLeaseId: () => `lease-${leaseNumber++}`,
		});
		const first = store.issue('endpoint-1');
		assert.throws(() => store.issue('endpoint-2'), /already awaiting consumption/);
		assert.strictEqual(store.revoke(first.leaseId), true);
		const second = store.issue('endpoint-2');

		assert.deepStrictEqual({
			first: { ...first, tokenBytes: Buffer.from(first.token, 'base64url').length },
			second: { ...second, tokenBytes: Buffer.from(second.token, 'base64url').length },
			distinctTokens: first.token !== second.token,
		}, {
			first: { leaseId: 'lease-1', endpointGeneration: 'endpoint-1', token: Buffer.alloc(32, 1).toString('base64url'), expiresAt: 16_000, tokenBytes: 32 },
			second: { leaseId: 'lease-2', endpointGeneration: 'endpoint-2', token: Buffer.alloc(32, 2).toString('base64url'), expiresAt: 16_000, tokenBytes: 32 },
			distinctTokens: true,
		});
		store.dispose();
	});

	it('consumes exactly once for the bound endpoint generation', () => {
		const store = new DtpTokenLeaseStore({
			createTokenBytes: size => Buffer.alloc(size, 7),
			createLeaseId: () => 'lease',
		});
		const lease = store.issue('generation-a');

		assert.deepStrictEqual([
			store.consume(lease.token, 'generation-b'),
			store.consume('wrong-token', 'generation-a'),
			store.consume(lease.token, 'generation-a'),
			store.consume(lease.token, 'generation-a'),
		], [false, false, true, false]);
		store.dispose();
	});

	it('rejects expiration at the exact TTL boundary', () => {
		const timers = new TestRelayTimers();
		let now = 100;
		const store = new DtpTokenLeaseStore({
			ttlMs: 20,
			timers,
			now: () => now,
			createTokenBytes: size => Buffer.alloc(size, 3),
			createLeaseId: () => `lease-${now}`,
		});
		const lease = store.issue('generation');
		now = 120;

		assert.strictEqual(store.consume(lease.token, 'generation'), false);
		assert.doesNotThrow(() => store.issue('next-generation'));
		store.dispose();
	});

	it('expires through the bounded timer and revokes on dispose', () => {
		const timers = new TestRelayTimers();
		let invalidations = 0;
		const store = new DtpTokenLeaseStore({
			ttlMs: 25,
			timers,
			createTokenBytes: size => Buffer.alloc(size, 4),
			createLeaseId: () => 'lease',
		});
		const lease = store.issue('generation', () => invalidations++);
		timers.runDelay(25);

		assert.strictEqual(store.consume(lease.token, 'generation'), false);
		const next = store.issue('next', () => invalidations++);
		store.dispose();
		assert.deepStrictEqual({ consumedAfterDispose: store.consume(next.token, 'next'), invalidations, timers: timers.pendingDelays() }, {
			consumedAfterDispose: false,
			invalidations: 2,
			timers: [],
		});
	});

	it('authenticates one DTP initialize and rejects replay', async () => {
		const store = new DtpTokenLeaseStore({
			createTokenBytes: size => Buffer.alloc(size, 9),
			createLeaseId: () => 'lease',
		});
		const lease = store.issue('generation');
		const firstTransport = new TestTransport();
		const first = new DelverDtpConnection(firstTransport, store.authenticator('generation'), new TestGateway());
		const firstResponse = firstTransport.request({
			id: 1,
			method: 'initialize',
			params: { protocolVersion: 1, token: lease.token, clientId: 'mcp:test' },
		});
		assert.strictEqual(Object.prototype.hasOwnProperty.call(await firstResponse, 'result'), true);

		const replayTransport = new TestTransport();
		const replay = new DelverDtpConnection(replayTransport, store.authenticator('generation'), new TestGateway());
		const replayResponse = await replayTransport.request({
			id: 2,
			method: 'initialize',
			params: { protocolVersion: 1, token: lease.token, clientId: 'mcp:replay' },
		});
		assert.deepStrictEqual(replayResponse, {
			id: 2,
			error: { code: DtpErrorCode.Unauthorized, message: 'The Delver session token is invalid.' },
		});

		first.dispose();
		replay.dispose();
		store.dispose();
	});

	it('notifies terminal outcomes without exposing credentials', () => {
		const store = new DtpTokenLeaseStore({
			createTokenBytes: size => Buffer.alloc(size, 8),
			createLeaseId: (() => {
				let next = 1;
				return () => `lease-${next++}`;
			})(),
		});
		const events: object[] = [];
		const removeListener = store.onDidChange(event => events.push(event));
		const consumed = store.issue('generation-a');
		assert.strictEqual(store.hasActiveLease(), true);
		assert.strictEqual(store.consume(consumed.token, consumed.endpointGeneration), true);
		store.issue('generation-b');
		assert.strictEqual(store.revokeActive(), true);
		removeListener();

		assert.deepStrictEqual({ events, active: store.hasActiveLease() }, {
			events: [
				{ type: 'issued', leaseId: 'lease-1' },
				{ type: 'consumed', leaseId: 'lease-1' },
				{ type: 'issued', leaseId: 'lease-2' },
				{ type: 'invalidated', leaseId: 'lease-2', reason: 'revoked' },
			],
			active: false,
		});
		assert.ok(!JSON.stringify(events).includes(consumed.token));
		store.dispose();
	});
});

class TestGateway implements IDelverAgentGateway {
	async capabilities(): Promise<unknown> {
		return {};
	}

	async invoke(): Promise<unknown> {
		return {};
	}

	async cancel(): Promise<void> { }
}

class TestTransport implements IDtpConnectionTransport {
	private readonly dataListeners = new Set<(data: Buffer) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly responseWaiters: ((response: IDtpResponse) => void)[] = [];

	onData(listener: (data: Buffer) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	write(data: Buffer): void {
		const frame = new DtpFrameDecoder().push(data)[0];
		this.responseWaiters.shift()?.(JSON.parse(frame.toString('utf8')) as IDtpResponse);
	}

	close(): void {
		for (const listener of [...this.closeListeners]) {
			listener();
		}
	}

	request(message: Readonly<Record<string, unknown>>): Promise<IDtpResponse> {
		const response = new Promise<IDtpResponse>(resolve => this.responseWaiters.push(resolve));
		for (const listener of this.dataListeners) {
			listener(encodeDtpMessage(message));
		}
		return response;
	}
}
