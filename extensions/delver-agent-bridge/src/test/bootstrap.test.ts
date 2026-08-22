/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
	BootstrapErrorCode,
	DelverBootstrapSession,
	IBootstrapClaim,
	IBootstrapProvision,
	IBootstrapTransport,
} from '../bootstrap';
import { DtpFrameDecoder } from '../protocol';
import { DtpTokenLeaseStore } from '../tokenLease';
import { TestRelayTimers } from './relayTestUtils';

const ROOT = 'a'.repeat(64);
const CLAIM: IBootstrapClaim = {
	protocolVersion: 1,
	registryEntryId: 'registry-entry',
	windowInstanceId: 'window-instance',
	rootFingerprint: ROOT,
	clientNonce: 'nonce_nonce_nonce_',
	displayName: 'Test MCP',
};

describe('Delver bootstrap session', () => {
	it('authorizes a verified peer before issuing one short-lived lease', async () => {
		const fixture = createFixture();
		const claim = fixture.transport.request(1, CLAIM, 9);
		const response = await claim;
		await settlePromises();
		assert.strictEqual(await fixture.session.whenClosed(), 'credentialIssued');
		const responseResult = isBootstrapResult(response) ? response.result : undefined;

		assert.deepStrictEqual({
			authorizations: fixture.authorizations,
			provisions: fixture.provisionCount,
			responseId: response.id,
			result: responseResult ? {
				protocolVersion: responseResult.protocolVersion,
				endpoint: responseResult.endpoint,
				leaseId: responseResult.leaseId,
				tokenBytes: Buffer.from(responseResult.token, 'base64url').length,
				expiresAt: responseResult.expiresAt,
			} : undefined,
			closed: fixture.transport.closeCount,
		}, {
			authorizations: [{ processId: 4242, displayName: 'Test MCP' }],
			provisions: 1,
			responseId: 1,
			result: {
				protocolVersion: 1,
				endpoint: 'pipe://private-session',
				leaseId: 'lease-1',
				tokenBytes: 32,
				expiresAt: 16_000,
			},
			closed: 1,
		});

		if (!isBootstrapResult(response)) {
			assert.fail('Expected a bootstrap credential result.');
		}
		assert.strictEqual(fixture.leases.consume(response.result.token, 'generation-1'), true);
		fixture.session.dispose();
		fixture.leases.dispose();
	});

	it('defaults to denial and never treats display metadata as peer identity', async () => {
		const transport = new TestBootstrapTransport();
		const leases = createLeaseStore();
		new DelverBootstrapSession(transport, {
			...baseOptions(leases),
			peerIdentity: { platform: 'win32', processId: 7331, executable: 'verified.exe' },
			provisionDtp: async () => {
				assert.fail('Default denial must not provision DTP.');
			},
		});
		const response = await transport.request(1, { ...CLAIM, displayName: 'verified.exe' });

		assert.deepStrictEqual(response, {
			id: 1,
			error: { code: BootstrapErrorCode.Denied, message: 'The bootstrap claim was not authorized.' },
		});
		leases.dispose();
	});

	it('rejects stale routing and malformed claims before authorization', async () => {
		for (const [claim, code] of [
			[{ ...CLAIM, windowInstanceId: 'stale-window' }, BootstrapErrorCode.StaleWindow],
			[{ ...CLAIM, rootFingerprint: 'b'.repeat(64) }, BootstrapErrorCode.RootMismatch],
			[{ ...CLAIM, clientNonce: 'short' }, BootstrapErrorCode.InvalidRequest],
			[{ ...CLAIM, displayName: 'spoofed\nVerified by the operating system' }, BootstrapErrorCode.InvalidRequest],
			[{ ...CLAIM, displayName: 'spoofed\u202Eeman' }, BootstrapErrorCode.InvalidRequest],
		] as const) {
			const fixture = createFixture();
			const response = await fixture.transport.request(1, claim);
			assert.deepStrictEqual({ code: isBootstrapError(response) ? response.error.code : undefined, authorizations: fixture.authorizations.length, provisions: fixture.provisionCount }, {
				code,
				authorizations: 0,
				provisions: 0,
			});
			fixture.leases.dispose();
		}
	});

	it('bounds framing and accepts only one concurrent claim', async () => {
		let resolveAuthorization: ((result: 'granted') => void) | undefined;
		const fixture = createFixture({
			authorize: async () => new Promise<'granted'>(resolve => resolveAuthorization = resolve),
		});
		fixture.transport.send(encodeRequest(1, CLAIM));
		const duplicate = fixture.transport.request(2, CLAIM);
		const response = await duplicate;
		resolveAuthorization?.('granted');
		await settlePromises();

		assert.deepStrictEqual({ response, provisions: fixture.provisionCount }, {
			response: { id: null, error: { code: BootstrapErrorCode.Busy, message: 'This bootstrap connection already has a claim.' } },
			provisions: 0,
		});

		const oversized = createFixture();
		const oversizedResponse = oversized.transport.waitForWrite();
		oversized.transport.send(Buffer.from(`Content-Length: ${16 * 1024 + 1}\r\n\r\n`, 'ascii'));
		assert.deepStrictEqual(await oversizedResponse, {
			id: null,
			error: { code: BootstrapErrorCode.InvalidRequest, message: 'The bootstrap frame is invalid.' },
		});
		fixture.leases.dispose();
		oversized.leases.dispose();
	});

	it('cancels provisioning on disconnect and revokes on response failure', async () => {
		let resolveProvision: ((provision: TestProvision) => void) | undefined;
		const disconnected = createFixture({
			provisionDtp: async () => new Promise<TestProvision>(resolve => resolveProvision = resolve),
		});
		disconnected.transport.send(encodeRequest(1, CLAIM));
		await settlePromises();
		disconnected.transport.disconnect();
		const lateProvision = new TestProvision();
		resolveProvision?.(lateProvision);
		await settlePromises();
		assert.strictEqual(lateProvision.disposeCount, 1);

		const failedWrite = createFixture();
		failedWrite.transport.failWrites = true;
		failedWrite.transport.send(encodeRequest(2, CLAIM));
		await settlePromises();
		assert.deepStrictEqual({ disposed: failedWrite.provision.disposeCount, tokenStillWorks: failedWrite.leases.consume(Buffer.alloc(32, 5).toString('base64url'), 'generation-1') }, {
			disposed: 1,
			tokenStillWorks: false,
		});
		disconnected.leases.dispose();
		failedWrite.leases.dispose();
	});

	it('revokes an unconsumed lease when the private DTP endpoint closes', async () => {
		const fixture = createFixture();
		const response = await fixture.transport.request(1, CLAIM);
		if (!isBootstrapResult(response)) {
			assert.fail('Expected a bootstrap credential result.');
		}
		fixture.provision.emitClose();
		assert.strictEqual(fixture.leases.consume(response.result.token, 'generation-1'), false);
		fixture.leases.dispose();
	});

	it('bounds the pre-claim wait for silent and fragmented peers', async () => {
		for (const fragment of [undefined, Buffer.from('Content-Length: 100\r\n\r\n{')]) {
			const fixture = createFixture();
			if (fragment) {
				fixture.transport.send(fragment);
			}
			fixture.sessionTimers.runDelay(5_000);
			assert.deepStrictEqual({ reason: await fixture.session.whenClosed(), authorizations: fixture.authorizations.length, provisions: fixture.provisionCount, closeCount: fixture.transport.closeCount }, {
				reason: 'claimTimeout',
				authorizations: 0,
				provisions: 0,
				closeCount: 1,
			});
			fixture.leases.dispose();
		}
	});
});

type BootstrapResponse = {
	readonly id: number | null;
	readonly result: {
		readonly protocolVersion: number;
		readonly endpoint: string;
		readonly leaseId: string;
		readonly token: string;
		readonly expiresAt: number;
	};
} | {
	readonly id: number | null;
	readonly error: { readonly code: BootstrapErrorCode; readonly message: string };
};

function isBootstrapResult(response: BootstrapResponse): response is Extract<BootstrapResponse, { readonly result: object }> {
	return Object.prototype.hasOwnProperty.call(response, 'result');
}

function isBootstrapError(response: BootstrapResponse): response is Extract<BootstrapResponse, { readonly error: object }> {
	return Object.prototype.hasOwnProperty.call(response, 'error');
}

class TestBootstrapTransport implements IBootstrapTransport {
	private readonly dataListeners = new Set<(data: Buffer) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly writeWaiters: ((response: BootstrapResponse) => void)[] = [];
	readonly writes: BootstrapResponse[] = [];
	closeCount = 0;
	failWrites = false;

	onData(listener: (data: Buffer) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async write(data: Buffer): Promise<void> {
		if (this.failWrites) {
			throw new Error('write failed');
		}
		const frame = new DtpFrameDecoder().push(data)[0];
		const response = JSON.parse(frame.toString('utf8')) as BootstrapResponse;
		this.writes.push(response);
		this.writeWaiters.shift()?.(response);
	}

	close(): void {
		this.closeCount++;
	}

	disconnect(): void {
		for (const listener of [...this.closeListeners]) {
			listener();
		}
	}

	send(data: Buffer): void {
		for (const listener of [...this.dataListeners]) {
			listener(data);
		}
	}

	request(id: number, claim: object, fragmentAt?: number): Promise<BootstrapResponse> {
		const response = this.waitForWrite();
		const request = encodeRequest(id, claim);
		if (fragmentAt === undefined) {
			this.send(request);
		} else {
			this.send(request.subarray(0, fragmentAt));
			this.send(request.subarray(fragmentAt));
		}
		return response;
	}

	waitForWrite(): Promise<BootstrapResponse> {
		return new Promise(resolve => this.writeWaiters.push(resolve));
	}

}

class TestProvision implements IBootstrapProvision {
	readonly endpoint = 'pipe://private-session';
	readonly endpointGeneration = 'generation-1';
	private readonly closeListeners = new Set<() => void>();
	disposeCount = 0;

	onDidClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	dispose(): void {
		this.disposeCount++;
	}

	emitClose(): void {
		for (const listener of [...this.closeListeners]) {
			listener();
		}
	}
}

function createFixture(overrides: {
	readonly authorize?: () => Promise<'granted' | 'denied' | 'expired' | 'cancelled' | 'busy' | 'unavailable' | 'unsupportedPeer'>;
	readonly provisionDtp?: () => Promise<TestProvision>;
} = {}) {
	const transport = new TestBootstrapTransport();
	const leases = createLeaseStore();
	const sessionTimers = new TestRelayTimers();
	const provision = new TestProvision();
	const authorizations: { readonly processId?: number; readonly displayName?: string }[] = [];
	let provisionCount = 0;
	const session = new DelverBootstrapSession(transport, {
		...baseOptions(leases),
		timers: sessionTimers,
		authorize: async (peer, claim) => {
			authorizations.push({ processId: peer.processId, displayName: claim.displayName });
			return overrides.authorize ? overrides.authorize() : 'granted';
		},
		provisionDtp: async () => {
			provisionCount++;
			return overrides.provisionDtp ? overrides.provisionDtp() : provision;
		},
	});
	return { transport, leases, provision, authorizations, get provisionCount() { return provisionCount; }, session, sessionTimers };
}

function baseOptions(leases: DtpTokenLeaseStore) {
	return {
		expectedRegistryEntryId: CLAIM.registryEntryId,
		expectedWindowInstanceId: CLAIM.windowInstanceId,
		expectedRootFingerprint: CLAIM.rootFingerprint,
		peerIdentity: { platform: 'win32' as const, processId: 4242, executable: 'verified.exe' },
		leases,
	};
}

function createLeaseStore(): DtpTokenLeaseStore {
	return new DtpTokenLeaseStore({
		timers: new TestRelayTimers(),
		now: () => 1_000,
		createTokenBytes: size => Buffer.alloc(size, 5),
		createLeaseId: () => 'lease-1',
	});
}

function encodeRequest(id: number, claim: object): Buffer {
	const body = Buffer.from(JSON.stringify({ id, method: 'bootstrap/claim', params: claim }), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
