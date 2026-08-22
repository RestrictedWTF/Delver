/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { BootstrapApprovalController, BootstrapApprovalShowWarningMessage, createModalBootstrapApprovalPrompt, formatBootstrapApprovalPrompt, IBootstrapApprovalPrompt, IBootstrapApprovalStrings } from '../approvalUi';
import { IBootstrapAuthorizationRequest, InMemoryBootstrapAuthorizer } from '../authorization';
import { IBootstrapClaim, IBootstrapPeerIdentity } from '../bootstrap';
import { TestRelayTimers } from './relayTestUtils';

const CLAIM: IBootstrapClaim = {
	protocolVersion: 1,
	registryEntryId: 'registry-secret-marker',
	windowInstanceId: 'window-secret-marker',
	rootFingerprint: 'f'.repeat(64),
	clientNonce: 'nonce_nonce_nonce_',
	displayName: 'Example Client',
};

describe('Bootstrap approval UI', () => {
	it('grants only the exact request on Allow Once', async () => {
		const fixture = createControllerFixture(async () => 'allow');
		const allowed = await fixture.authorizer.authorize(windowsPeer(42), CLAIM, new AbortController().signal);

		assert.strictEqual(allowed, 'granted');
		assert.strictEqual(fixture.authorizer.grantOnce('authorization-request-1'), false);
		fixture.controller.dispose();
		fixture.authorizer.dispose();
	});

	it('denies explicit denial, dismissal, and prompt failure', async () => {
		for (const prompt of [
			async () => 'deny' as const,
			async () => undefined,
			async () => { throw new Error('UI failed'); },
		]) {
			const fixture = createControllerFixture(prompt);
			assert.strictEqual(await fixture.authorizer.authorize(windowsPeer(42), CLAIM, new AbortController().signal), 'denied');
			fixture.controller.dispose();
			fixture.authorizer.dispose();
		}
	});

	it('disposal denies the active request and invalidates a late approval', async () => {
		const decision = deferred<'allow'>();
		const fixture = createControllerFixture(() => decision.promise);
		const pending = fixture.authorizer.authorize(windowsPeer(42), CLAIM, new AbortController().signal);

		fixture.controller.dispose();
		decision.resolve('allow');

		assert.strictEqual(await pending, 'denied');
		assert.strictEqual(fixture.authorizer.grantOnce('authorization-request-1'), false);
		fixture.controller.dispose();
		fixture.authorizer.dispose();
	});

	it('does not stack a second prompt while an expired or disconnected modal is unresolved', async () => {
		const decision = deferred<'allow'>();
		let promptCount = 0;
		const fixture = createControllerFixture(() => {
			promptCount++;
			return decision.promise;
		});
		const disconnected = new AbortController();
		const busyChanges: boolean[] = [];
		fixture.controller.onDidChangeBusy(busy => busyChanges.push(busy));
		const first = fixture.authorizer.authorize(windowsPeer(42), CLAIM, disconnected.signal);
		disconnected.abort();
		const second = fixture.authorizer.authorize(windowsPeer(42), CLAIM, new AbortController().signal);
		assert.strictEqual(fixture.controller.isBusy(), true);

		decision.resolve('allow');
		await settlePromises();

		assert.deepStrictEqual({ first: await first, second: await second, promptCount, busy: fixture.controller.isBusy(), busyChanges }, {
			first: 'cancelled',
			second: 'denied',
			promptCount: 1,
			busy: false,
			busyChanges: [true, false],
		});
		fixture.controller.dispose();
		fixture.authorizer.dispose();
	});

	it('formats OS-attested identities separately from the unverified name without protocol secrets', () => {
		const variants = [
			request({ platform: 'linux', processId: 42, userId: 1000 }),
			request({ platform: 'win32', processId: 42 }),
			request({ platform: 'darwin', userId: 1000 }, false),
		];
		const contents = variants.map(value => formatBootstrapApprovalPrompt(value, testStrings));
		const rendered = JSON.stringify(contents);

		assert.match(contents[0].detail, /platform linux, process ID 42, user ID 1000/);
		assert.match(contents[0].detail, /Application-provided name \(not verified\): Example Client/);
		assert.match(contents[1].detail, /platform win32, process ID 42/);
		assert.match(contents[2].detail, /platform darwin, user ID 1000/);
		assert.doesNotMatch(contents[2].detail, /Application-provided name/);
		for (const secret of [CLAIM.registryEntryId, CLAIM.windowInstanceId, CLAIM.rootFingerprint, CLAIM.clientNonce, 'endpoint', 'token']) {
			assert.ok(!rendered.includes(secret), `Prompt must not contain ${secret}.`);
		}
		assert.deepStrictEqual({ allow: contents[0].allowOnce, deny: contents[0].deny }, { allow: 'Allow Once', deny: 'Deny' });
		assert.doesNotMatch(rendered, /Always|Remember/);
	});

	it('uses a modal warning, a close-affordance denial, and exact item identity', async () => {
		const calls: { message: string; options: { modal: true; detail: string }; items: readonly { title: string; isCloseAffordance?: boolean }[] }[] = [];
		let returnExactAllowItem = false;
		const showWarningMessage: BootstrapApprovalShowWarningMessage = async (message, options, ...items) => {
			calls.push({ message, options, items });
			return returnExactAllowItem ? items[0] : { title: items[0].title };
		};
		const prompt = createModalBootstrapApprovalPrompt(showWarningMessage, testStrings);
		const signal = new AbortController().signal;

		assert.strictEqual(await prompt.show(request(windowsPeer(42)), signal), 'deny');
		returnExactAllowItem = true;
		assert.strictEqual(await prompt.show(request(windowsPeer(42)), signal), 'allow');

		assert.strictEqual(calls[0].options.modal, true);
		assert.match(calls[0].options.detail, /Approve only if you initiated this connection/);
		assert.deepStrictEqual(calls[0].items.map(item => ({ title: item.title, close: item.isCloseAffordance ?? false })), [
			{ title: 'Allow Once', close: false },
			{ title: 'Deny', close: true },
		]);
	});
});

function createControllerFixture(show: IBootstrapApprovalPrompt['show']) {
	const timers = new TestRelayTimers();
	let requestNumber = 1;
	const authorizer = new InMemoryBootstrapAuthorizer({
		timers,
		now: () => 1_000,
		createRequestId: () => `authorization-request-${requestNumber++}`,
	});
	const controller = new BootstrapApprovalController(authorizer, { show });
	return { authorizer, controller, timers };
}

function request(peer: IBootstrapPeerIdentity, includeDisplayName = true): IBootstrapAuthorizationRequest {
	return {
		authorizationRequestId: 'authorization-request-1',
		peer,
		registryEntryId: CLAIM.registryEntryId,
		windowInstanceId: CLAIM.windowInstanceId,
		rootFingerprint: CLAIM.rootFingerprint,
		...(includeDisplayName ? { untrustedDisplayName: CLAIM.displayName } : {}),
		createdAt: 1_000,
		expiresAt: 31_000,
	};
}

function windowsPeer(processId: number): IBootstrapPeerIdentity {
	return { platform: 'win32', processId };
}

const testStrings: IBootstrapApprovalStrings = {
	message: 'Allow a local application to connect to this Delver window?',
	verifiedProcessAndUser: (platform, processId, userId) => `Verified by the operating system: platform ${platform}, process ID ${processId}, user ID ${userId}.`,
	verifiedProcess: (platform, processId) => `Verified by the operating system: platform ${platform}, process ID ${processId}.`,
	verifiedUser: (platform, userId) => `Verified by the operating system: platform ${platform}, user ID ${userId}.`,
	untrustedName: displayName => `Application-provided name (not verified): ${displayName}`,
	access: 'Allow Once gives this connection access to this window\'s Delver agent tools. It may expose target-derived pseudocode, disassembly, strings, and metadata, and may perform supported navigation or actions. Approve only if you initiated this connection.',
	allowOnce: 'Allow Once',
	deny: 'Deny',
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolver => resolve = resolver);
	return { promise, resolve };
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
