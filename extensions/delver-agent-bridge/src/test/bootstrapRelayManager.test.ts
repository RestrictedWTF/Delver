/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { IBootstrapPeerIdentity } from '../bootstrap';
import { DelverBootstrapRelayManager, IBootstrapRelayPublicationEntry } from '../bootstrapRelayManager';
import { BOOTSTRAP_MAX_BUFFERED_INPUT_BYTES, GatedBootstrapRelayTransport } from '../bootstrapRelayTransport';
import { TestRelayProcess, TestRelayTimers } from './relayTestUtils';

const READY = '{"event":"ready","schemaVersion":1}\n';
const PEER = '{"event":"peer","schemaVersion":1,"processId":4242}\n';

describe('Bootstrap relay manager', () => {
	it('publishes only after every input/control listener and peer timeout are armed', async () => {
		const fixture = createFixture({
			publish: (entry, current) => {
				fixture.publishObservations.push({ entry, listeners: current.listenerCounts(), timers: fixture.timers.pendingDelays() });
			},
		});
		const started = fixture.manager.start();
		assert.deepStrictEqual(fixture.publications, []);
		fixture.process.emitStderr(READY);
		await started;

		assert.deepStrictEqual(fixture.publishObservations, [{
			entry: { endpoint: 'pipe://bootstrap-attempt', expiresAt: 31_000 },
			listeners: { stdout: 1, stderr: 1, exit: 1, error: 1 },
			timers: [30_000],
		}]);
		fixture.manager.dispose();
		await fixture.manager.whenClosed();
	});

	it('preserves an immediate claim in either cross-stream order and unpublishes before release', async () => {
		for (const claimFirst of [true, false]) {
			const events: string[] = [];
			const fixture = createFixture({
				publish: (_entry, process) => {
					events.push('publish');
					if (claimFirst) {
						process.emitStdout('claim-bytes');
						process.emitStderr(PEER);
					} else {
						process.emitStderr(PEER);
						process.emitStdout('claim-bytes');
					}
				},
				onUnpublish: () => events.push('unpublish'),
				onSession: () => events.push('session'),
				onData: () => events.push('data'),
			});
			const started = fixture.manager.start();
			fixture.process.emitStderr(READY);
			await started;
			await settlePromises();

			assert.deepStrictEqual({
				events,
				peer: fixture.sessions[0].peer,
				data: fixture.sessions[0].data,
				publications: fixture.publications,
			}, {
				events: ['publish', 'unpublish', 'session', 'data'],
				peer: { platform: 'win32', processId: 4242 },
				data: ['claim-bytes'],
				publications: [{ endpoint: 'pipe://bootstrap-attempt', expiresAt: 31_000 }],
			});
			fixture.manager.dispose();
			await fixture.manager.whenClosed();
		}
	});

	it('fails closed on oversized pre-attestation input and peer timeout', async () => {
		const overflow = createFixture();
		const overflowStarted = overflow.manager.start();
		overflow.process.emitStderr(READY);
		await overflowStarted;
		overflow.process.emitStdout(Buffer.alloc(BOOTSTRAP_MAX_BUFFERED_INPUT_BYTES + 1));
		assert.strictEqual(await overflow.manager.whenClosed(), 'transportFailure');

		const timedOut = createFixture();
		const timeoutStarted = timedOut.manager.start();
		timedOut.process.emitStderr(READY);
		await timeoutStarted;
		timedOut.timers.runDelay(30_000);
		assert.strictEqual(await timedOut.manager.whenClosed(), 'idleTimeout');

		assert.deepStrictEqual({
			overflow: summarizeCleanup(overflow),
			timedOut: summarizeCleanup(timedOut),
		}, {
			overflow: { sessions: 0, unpublishes: 1, terminations: 1, cleanup: 1, timers: [] },
			timedOut: { sessions: 0, unpublishes: 1, terminations: 1, cleanup: 1, timers: [] },
		});
	});

	it('never publishes malformed readiness and cleans malformed peer records once', async () => {
		const badReady = createFixture();
		const rejectedStart = assert.rejects(badReady.manager.start(), /readiness record is invalid/);
		badReady.process.emitStderr('{"event":"wrong","schemaVersion":1}\n');
		await rejectedStart;
		assert.strictEqual(await badReady.manager.whenClosed(), 'readinessFailure');

		const badPeer = createFixture();
		const started = badPeer.manager.start();
		badPeer.process.emitStderr(READY);
		await started;
		badPeer.process.emitStderr('{"event":"peer","schemaVersion":1,"extra":true}\n');
		assert.strictEqual(await badPeer.manager.whenClosed(), 'controlViolation');

		assert.deepStrictEqual({
			badReady: { publications: badReady.publications.length, ...summarizeCleanup(badReady) },
			badPeer: { publications: badPeer.publications.length, ...summarizeCleanup(badPeer) },
		}, {
			badReady: { publications: 0, sessions: 0, unpublishes: 0, terminations: 1, cleanup: 1, timers: [] },
			badPeer: { publications: 1, sessions: 0, unpublishes: 1, terminations: 1, cleanup: 1, timers: [] },
		});
	});

	it('disposes a publication returned after reentrant relay closure', async () => {
		const fixture = createFixture({
			publish: (_entry, process) => process.emitExit(1),
		});
		const rejectedStart = assert.rejects(fixture.manager.start(), /closed/);
		fixture.process.emitStderr(READY);
		await rejectedStart;
		await fixture.manager.whenClosed();
		await settlePromises();

		assert.deepStrictEqual(summarizeCleanup(fixture), {
			sessions: 0,
			unpublishes: 1,
			terminations: 0,
			cleanup: 1,
			timers: [],
		});
	});

	it('binds delayed publication to the relay peer deadline and disposes a late result', async () => {
		const fixture = createFixture({ deferPublication: true });
		const rejectedStart = assert.rejects(fixture.manager.start(), /attestation timed out/);
		fixture.process.emitStderr(READY);

		assert.strictEqual(fixture.publications[0].expiresAt, 31_000);
		fixture.timers.runDelay(30_000);
		await rejectedStart;
		fixture.resolvePublication();
		assert.strictEqual(await fixture.manager.whenClosed(), 'idleTimeout');
		await settlePromises();

		assert.deepStrictEqual({ unpublishes: fixture.unpublishCount, cleanup: fixture.cleanupCount, timers: fixture.timers.pendingDelays() }, {
			unpublishes: 1,
			cleanup: 1,
			timers: [],
		});
	});

	it('serves only one peer and completes after the bootstrap session closes', async () => {
		const fixture = createFixture();
		const started = fixture.manager.start();
		fixture.process.emitStderr(`${READY}${PEER}`);
		await started;
		fixture.process.emitStdout('claim');
		await settlePromises();
		fixture.sessions[0].close();
		await fixture.manager.whenClosed();
		fixture.process.emitStderr(PEER);
		fixture.process.emitError();

		assert.deepStrictEqual({
			sessions: fixture.sessions.length,
			data: fixture.sessions[0].data,
			disposeCalls: fixture.sessions[0].disposeCalls,
			cleanup: fixture.cleanupCount,
			unpublishes: fixture.unpublishCount,
			endCount: fixture.process.endCount,
		}, {
			sessions: 1,
			data: ['claim'],
			disposeCalls: [false],
			cleanup: 1,
			unpublishes: 1,
			endCount: 1,
		});
	});

	it('awaits durable unpublication before releasing claims and fails closed on unlink errors', async () => {
		const delayed = createFixture({ deferUnpublish: true });
		const started = delayed.manager.start();
		delayed.process.emitStderr(READY);
		await started;
		delayed.process.emitStdout('claim');
		delayed.process.emitStderr(PEER);
		await settlePromises();
		assert.deepStrictEqual({ sessions: delayed.sessions.length, buffered: delayed.process.listenerCounts().stdout }, { sessions: 0, buffered: 1 });
		delayed.resolveUnpublish();
		await settlePromises();
		assert.deepStrictEqual({ sessions: delayed.sessions.length, data: delayed.sessions[0].data }, { sessions: 1, data: ['claim'] });
		delayed.manager.dispose();
		await delayed.manager.whenClosed();

		const failed = createFixture({ unpublishFails: true });
		const failedStarted = failed.manager.start();
		failed.process.emitStderr(READY);
		await failedStarted;
		failed.process.emitStdout('claim');
		failed.process.emitStderr(PEER);
		assert.strictEqual(await failed.manager.whenClosed(), 'publicationFailure');
		assert.deepStrictEqual({ sessions: failed.sessions.length, terminations: failed.process.terminateCount }, { sessions: 0, terminations: 1 });
	});

	it('contains a rejected late-publication cleanup after the first close reason', async () => {
		const fixture = createFixture({ deferPublication: true, unpublishFails: true });
		const rejectedStart = assert.rejects(fixture.manager.start(), /attestation timed out/);
		fixture.process.emitStderr(READY);
		fixture.timers.runDelay(30_000);
		await rejectedStart;
		fixture.resolvePublication();

		assert.strictEqual(await fixture.manager.whenClosed(), 'idleTimeout');
		assert.deepStrictEqual({ unpublishes: fixture.unpublishCount, cleanup: fixture.cleanupCount }, { unpublishes: 1, cleanup: 1 });
	});
});

interface IFixtureOptions {
	readonly publish?: (entry: IBootstrapRelayPublicationEntry, process: TestRelayProcess) => void;
	readonly onUnpublish?: () => void;
	readonly onSession?: () => void;
	readonly onData?: () => void;
	readonly deferPublication?: boolean;
	readonly deferUnpublish?: boolean;
	readonly unpublishFails?: boolean;
}

class TestBootstrapSession {
	readonly data: string[] = [];
	readonly disposeCalls: boolean[] = [];
	private readonly removeDataListener: () => void;
	private readonly completionPromise: Promise<'credentialIssued' | 'disposed'>;
	private resolveCompletion!: (reason: 'credentialIssued' | 'disposed') => void;

	constructor(readonly peer: IBootstrapPeerIdentity, private readonly transport: GatedBootstrapRelayTransport, onData: () => void) {
		this.completionPromise = new Promise(resolve => this.resolveCompletion = resolve);
		this.removeDataListener = transport.onData(data => {
			this.data.push(data.toString());
			onData();
		});
	}

	dispose(closeTransport = true): void {
		this.disposeCalls.push(closeTransport);
		this.removeDataListener();
		if (closeTransport) {
			this.transport.close();
		}
		this.resolveCompletion('disposed');
	}

	whenClosed(): Promise<'credentialIssued' | 'disposed'> {
		return this.completionPromise;
	}

	close(): void {
		this.resolveCompletion('credentialIssued');
		this.transport.close();
	}
}

function createFixture(options: IFixtureOptions = {}) {
	const process = new TestRelayProcess();
	const timers = new TestRelayTimers();
	const publications: IBootstrapRelayPublicationEntry[] = [];
	const publishObservations: { readonly entry: IBootstrapRelayPublicationEntry; readonly listeners: ReturnType<TestRelayProcess['listenerCounts']>; readonly timers: readonly number[] }[] = [];
	const sessions: TestBootstrapSession[] = [];
	let cleanupCount = 0;
	let unpublishCount = 0;
	let resolvePublication = () => { };
	let resolveUnpublish = () => { };
	const manager = new DelverBootstrapRelayManager({
		executable: 'C:\\Delver\\delver-agent-relay.exe',
		spawn: () => process,
		createAttempt: () => ({
			endpoint: 'pipe://bootstrap-attempt',
			cleanup: async () => {
				cleanupCount++;
			},
		}),
		publish: entry => {
			publications.push(entry);
			options.publish?.(entry, process);
			const publication = {
				dispose: async () => {
					unpublishCount++;
					options.onUnpublish?.();
					if (options.deferUnpublish) {
						await new Promise<void>(resolve => resolveUnpublish = resolve);
					}
					if (options.unpublishFails) {
						throw new Error('unlink failed');
					}
				},
			};
			if (options.deferPublication) {
				return new Promise(resolve => resolvePublication = () => resolve(publication));
			}
			return publication;
		},
		createSession: (transport, peer) => {
			options.onSession?.();
			const session = new TestBootstrapSession(peer, transport, () => options.onData?.());
			sessions.push(session);
			return session;
		},
		platform: 'win32',
		timers,
		now: () => 1_000,
	});
	return {
		manager,
		process,
		timers,
		publications,
		publishObservations,
		sessions,
		get cleanupCount() { return cleanupCount; },
		get unpublishCount() { return unpublishCount; },
		resolvePublication: () => resolvePublication(),
		resolveUnpublish: () => resolveUnpublish(),
	};
}

function summarizeCleanup(fixture: ReturnType<typeof createFixture>) {
	return {
		sessions: fixture.sessions.length,
		unpublishes: fixture.unpublishCount,
		terminations: fixture.process.terminateCount,
		cleanup: fixture.cleanupCount,
		timers: fixture.timers.pendingDelays(),
	};
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
