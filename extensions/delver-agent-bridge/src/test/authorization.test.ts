/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { InMemoryBootstrapAuthorizer, IBootstrapAuthorizationRequest } from '../authorization';
import { IBootstrapClaim, IBootstrapPeerIdentity } from '../bootstrap';
import { TestRelayTimers } from './relayTestUtils';

const CLAIM: IBootstrapClaim = {
	protocolVersion: 1,
	registryEntryId: 'registry-entry',
	windowInstanceId: 'window-instance',
	rootFingerprint: 'a'.repeat(64),
	clientNonce: 'nonce_nonce_nonce_',
	displayName: 'Self-Asserted MCP',
};

describe('Bootstrap authorization', () => {
	it('requires an exact one-shot grant and exposes only bounded approval context', async () => {
		const fixture = createFixture();
		const pending = fixture.authorizer.authorize({ platform: 'win32', processId: 42, executable: 'not-attested.exe' }, CLAIM, new AbortController().signal);
		const request = fixture.requests[0];

		assert.deepStrictEqual(request, {
			authorizationRequestId: 'authorization-request-1',
			peer: { platform: 'win32', processId: 42 },
			registryEntryId: CLAIM.registryEntryId,
			windowInstanceId: CLAIM.windowInstanceId,
			rootFingerprint: CLAIM.rootFingerprint,
			untrustedDisplayName: 'Self-Asserted MCP',
			createdAt: 1_000,
			expiresAt: 31_000,
		});
		assert.deepStrictEqual({ firstGrant: fixture.authorizer.grantOnce(request.authorizationRequestId), allowed: await pending, replay: fixture.authorizer.grantOnce(request.authorizationRequestId) }, {
			firstGrant: true,
			allowed: 'granted',
			replay: false,
		});
		fixture.authorizer.dispose();
	});

	it('denies by default, on explicit denial, and while another request is pending', async () => {
		const withoutObserver = new InMemoryBootstrapAuthorizer();
		assert.strictEqual(await withoutObserver.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal), 'unavailable');

		const fixture = createFixture();
		const first = fixture.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal);
		const concurrent = await fixture.authorizer.authorize({ platform: 'win32', processId: 43 }, CLAIM, new AbortController().signal);
		const denied = fixture.authorizer.deny(fixture.requests[0].authorizationRequestId);

		assert.deepStrictEqual({ concurrent, denied, first: await first }, { concurrent: 'busy', denied: true, first: 'denied' });
		withoutObserver.dispose();
		fixture.authorizer.dispose();
	});

	it('cancels a disconnected request and never reuses its approval for the same PID', async () => {
		const fixture = createFixture();
		const firstAbort = new AbortController();
		const first = fixture.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, firstAbort.signal);
		const firstId = fixture.requests[0].authorizationRequestId;
		firstAbort.abort();

		const second = fixture.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal);
		const secondId = fixture.requests[1].authorizationRequestId;
		const staleGrant = fixture.authorizer.grantOnce(firstId);
		const currentGrant = fixture.authorizer.grantOnce(secondId);

		assert.deepStrictEqual({ first: await first, distinct: firstId !== secondId, staleGrant, currentGrant, second: await second }, {
			first: 'cancelled',
			distinct: true,
			staleGrant: false,
			currentGrant: true,
			second: 'granted',
		});
		fixture.authorizer.dispose();
	});

	it('expires pending grants and resolves disposal without late approval', async () => {
		const expired = createFixture({ ttlMs: 25 });
		let expiredSignal: AbortSignal | undefined;
		expired.authorizer.onDidRequest((_request, signal) => expiredSignal = signal);
		const expiredResult = expired.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal);
		const expiredId = expired.requests[0].authorizationRequestId;
		expired.timers.runDelay(25);

		const disposed = createFixture();
		const disposedResult = disposed.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal);
		const disposedId = disposed.requests[0].authorizationRequestId;
		disposed.authorizer.dispose();

		assert.deepStrictEqual({ expired: await expiredResult, lateExpired: expired.authorizer.grantOnce(expiredId), disposed: await disposedResult, lateDisposed: disposed.authorizer.grantOnce(disposedId) }, {
			expired: 'expired',
			lateExpired: false,
			disposed: 'cancelled',
			lateDisposed: false,
		});
		assert.strictEqual(expiredSignal?.aborted, true);
		expired.authorizer.dispose();
	});

	it('enforces platform-specific kernel identity requirements before notifying', async () => {
		const fixture = createFixture({ currentUserId: 1000 });
		const peers: readonly IBootstrapPeerIdentity[] = [
			{ platform: 'win32' },
			{ platform: 'linux', processId: 42 },
			{ platform: 'linux', processId: 42, userId: 1001 },
			{ platform: 'freebsd', userId: 1001 },
			{ platform: 'aix', processId: 42, userId: 1000 },
		];
		const denied = await Promise.all(peers.map(peer => fixture.authorizer.authorize(peer, CLAIM, new AbortController().signal)));

		const linux = fixture.authorizer.authorize({ platform: 'linux', processId: 42, userId: 1000 }, CLAIM, new AbortController().signal);
		fixture.authorizer.grantOnce(fixture.requests[0].authorizationRequestId);
		const freeBsd = fixture.authorizer.authorize({ platform: 'freebsd', userId: 1000 }, CLAIM, new AbortController().signal);
		fixture.authorizer.grantOnce(fixture.requests[1].authorizationRequestId);

		assert.deepStrictEqual({ denied, requests: fixture.requests.map(request => request.peer), linux: await linux, freeBsd: await freeBsd }, {
			denied: ['unsupportedPeer', 'unsupportedPeer', 'unsupportedPeer', 'unsupportedPeer', 'unsupportedPeer'],
			requests: [
				{ platform: 'linux', processId: 42, userId: 1000 },
				{ platform: 'freebsd', userId: 1000 },
			],
			linux: 'granted',
			freeBsd: 'granted',
		});
		fixture.authorizer.dispose();
	});

	it('fails closed on observer errors and duplicate request identifiers', async () => {
		let requestNumber = 0;
		const fixture = createFixture({ createRequestId: () => 'duplicate-request' });
		fixture.authorizer.onDidRequest(() => {
			requestNumber++;
			throw new Error('observer failed');
		});
		const first = fixture.authorizer.authorize({ platform: 'win32', processId: 42 }, CLAIM, new AbortController().signal);
		fixture.authorizer.deny(fixture.requests[0].authorizationRequestId);
		const duplicate = await fixture.authorizer.authorize({ platform: 'win32', processId: 43 }, CLAIM, new AbortController().signal);

		assert.deepStrictEqual({ first: await first, duplicate, requestNumber, pendingTimers: fixture.timers.pendingDelays() }, {
			first: 'denied',
			duplicate: 'unavailable',
			requestNumber: 1,
			pendingTimers: [],
		});
		fixture.authorizer.dispose();
	});
});

function createFixture(options: { readonly ttlMs?: number; readonly currentUserId?: number; readonly createRequestId?: () => string } = {}) {
	const timers = new TestRelayTimers();
	const requests: IBootstrapAuthorizationRequest[] = [];
	let requestNumber = 1;
	const authorizer = new InMemoryBootstrapAuthorizer({
		ttlMs: options.ttlMs,
		timers,
		now: () => 1_000,
		getCurrentUserId: () => options.currentUserId,
		createRequestId: options.createRequestId ?? (() => `authorization-request-${requestNumber++}`),
	});
	authorizer.onDidRequest(request => requests.push(request));
	return { authorizer, requests, timers };
}
