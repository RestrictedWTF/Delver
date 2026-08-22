/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { BootstrapRelayCloseReason } from '../bootstrapRelayManager';
import { DelverWindowRendezvousLifecycle, IRendezvousApprovalBusyGate, IRendezvousLifecycleManager, IRendezvousLifecycleManagerContext } from '../rendezvousLifecycle';
import { IRendezvousRegistry, IRendezvousRegistryEntry, IRendezvousRegistryPublication } from '../rendezvousRegistry';
import { DtpTokenLeaseStore } from '../tokenLease';
import { TestRelayTimers } from './relayTestUtils';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);

describe('Window rendezvous lifecycle', () => {
	it('publishes strict generations and applies idle and technical backoff independently', async () => {
		const fixture = createFixture();
		fixture.lifecycle.setRoot(ROOT_A);
		fixture.lifecycle.start();
		await settlePromises();
		fixture.managers[0].close('idleTimeout');
		await settlePromises();
		assert.deepStrictEqual({ entries: fixture.registry.entries, active: [...fixture.registry.activeIds], delays: fixture.timers.pendingDelays() }, {
			entries: [{
				schemaVersion: 1,
				bootstrapProtocolVersion: 1,
				registryEntryId: 'registry-entry-01',
				windowInstanceId: 'window-instance-01',
				rootFingerprint: ROOT_A,
				bootstrapEndpoint: 'pipe://bootstrap-1',
				ownerProcessId: 4242,
				publishedAt: 1_000,
				expiresAt: 31_000,
			}],
			active: [],
			delays: [250],
		});

		fixture.timers.runDelay(250);
		await settlePromises();
		for (const delay of [1_000, 2_000, 5_000, 15_000, 30_000, 30_000]) {
			fixture.managers.at(-1)!.close('transportFailure');
			await settlePromises();
			assert.deepStrictEqual(fixture.timers.pendingDelays(), [delay]);
			fixture.timers.runDelay(delay);
			await settlePromises();
		}
		fixture.lifecycle.dispose();
		await fixture.lifecycle.whenDisposed();
	});

	it('backs off prompt outcomes and never republishes while a lease is live', async () => {
		const fixture = createFixture();
		fixture.lifecycle.setRoot(ROOT_A);
		fixture.lifecycle.start();
		await settlePromises();

		for (const delay of [30_000, 120_000]) {
			fixture.managers.at(-1)!.close('authorizationDenied');
			await settlePromises();
			assert.deepStrictEqual(fixture.timers.pendingDelays(), [delay]);
			fixture.timers.runDelay(delay);
			await settlePromises();
		}

		const lease = fixture.leases.issue('generation-live');
		fixture.managers.at(-1)!.close('credentialIssued');
		await settlePromises();
		assert.deepStrictEqual({ managers: fixture.managers.length, delays: fixture.timers.pendingDelays(), activeLease: fixture.leases.hasActiveLease() }, {
			managers: 3,
			delays: [],
			activeLease: true,
		});
		assert.strictEqual(fixture.leases.consume(lease.token, lease.endpointGeneration), true);
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [250]);
		fixture.timers.runDelay(250);
		await settlePromises();
		fixture.managers.at(-1)!.close('authorizationDenied');
		await settlePromises();
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [30_000]);

		fixture.lifecycle.dispose();
		await fixture.lifecycle.whenDisposed();
	});

	it('penalizes an unconsumed invalidated lease and gates publication on a stale modal', async () => {
		const fixture = createFixture();
		fixture.busy.setBusy(true);
		fixture.lifecycle.setRoot(ROOT_A);
		fixture.lifecycle.start();
		assert.strictEqual(fixture.managers.length, 0);
		fixture.busy.setBusy(false);
		await settlePromises();

		fixture.leases.issue('generation-live');
		fixture.managers[0].close('credentialIssued');
		await settlePromises();
		fixture.leases.revokeActive('endpointClosed');
		assert.deepStrictEqual(fixture.timers.pendingDelays(), [30_000]);
		fixture.busy.setBusy(true);
		fixture.timers.runDelay(30_000);
		assert.strictEqual(fixture.managers.length, 1);
		fixture.busy.setBusy(false);
		await settlePromises();
		assert.strictEqual(fixture.managers.length, 2);

		fixture.lifecycle.dispose();
		await fixture.lifecycle.whenDisposed();
	});

	it('serializes root rotation behind teardown and ignores stale outcomes', async () => {
		const fixture = createFixture({ deferManagerDisposal: true });
		fixture.lifecycle.setRoot(ROOT_A);
		fixture.lifecycle.start();
		await settlePromises();
		const first = fixture.managers[0];
		fixture.leases.issue('generation-old');

		fixture.lifecycle.setRoot(ROOT_B);
		fixture.lifecycle.setRoot('c'.repeat(64));
		assert.deepStrictEqual({ disposed: first.disposeCount, activeLease: fixture.leases.hasActiveLease(), managers: fixture.managers.length }, {
			disposed: 1,
			activeLease: false,
			managers: 1,
		});
		first.finishDeferredDisposal();
		await settlePromises();
		assert.deepStrictEqual(fixture.managers.map(manager => ({ window: manager.context.windowInstanceId, root: manager.context.rootFingerprint })), [
			{ window: 'window-instance-01', root: ROOT_A },
			{ window: 'window-instance-03', root: 'c'.repeat(64) },
		]);

		fixture.lifecycle.dispose();
		fixture.managers[1].finishDeferredDisposal();
		await fixture.lifecycle.whenDisposed();
		assert.deepStrictEqual({ timers: fixture.timers.pendingDelays(), active: [...fixture.registry.activeIds] }, { timers: [], active: [] });
	});

	it('gives lease outcomes priority over manager-close ordering', async () => {
		const pendingInvalidation = createFixture();
		pendingInvalidation.lifecycle.setRoot(ROOT_A);
		pendingInvalidation.lifecycle.start();
		await settlePromises();
		pendingInvalidation.leases.issue('generation-a');
		pendingInvalidation.leases.revokeActive('endpointClosed');
		pendingInvalidation.managers[0].close('internalFailure');
		await settlePromises();
		assert.deepStrictEqual(pendingInvalidation.timers.pendingDelays(), [30_000]);
		pendingInvalidation.lifecycle.dispose();
		await pendingInvalidation.lifecycle.whenDisposed();

		const lateInvalidation = createFixture();
		lateInvalidation.lifecycle.setRoot(ROOT_A);
		lateInvalidation.lifecycle.start();
		await settlePromises();
		lateInvalidation.leases.issue('generation-b');
		lateInvalidation.managers[0].close('internalFailure');
		await settlePromises();
		assert.deepStrictEqual(lateInvalidation.timers.pendingDelays(), [1_000]);
		lateInvalidation.leases.revokeActive('endpointClosed');
		assert.deepStrictEqual(lateInvalidation.timers.pendingDelays(), [30_000]);
		lateInvalidation.lifecycle.dispose();
		await lateInvalidation.lifecycle.whenDisposed();

		const consumedBeforeFailure = createFixture();
		consumedBeforeFailure.lifecycle.setRoot(ROOT_A);
		consumedBeforeFailure.lifecycle.start();
		await settlePromises();
		const lease = consumedBeforeFailure.leases.issue('generation-c');
		consumedBeforeFailure.leases.consume(lease.token, lease.endpointGeneration);
		consumedBeforeFailure.managers[0].close('internalFailure');
		await settlePromises();
		assert.deepStrictEqual(consumedBeforeFailure.timers.pendingDelays(), [250]);
		consumedBeforeFailure.lifecycle.dispose();
		await consumedBeforeFailure.lifecycle.whenDisposed();
	});
});

class TestRegistry implements IRendezvousRegistry {
	readonly entries: IRendezvousRegistryEntry[] = [];
	readonly activeIds = new Set<string>();

	async publish(entry: IRendezvousRegistryEntry): Promise<IRendezvousRegistryPublication> {
		this.entries.push(entry);
		this.activeIds.add(entry.registryEntryId);
		return {
			dispose: async () => {
				this.activeIds.delete(entry.registryEntryId);
			},
		};
	}

	async list(): Promise<readonly IRendezvousRegistryEntry[]> {
		return this.entries;
	}

	async prune(): Promise<void> { }
}

class TestBusyGate implements IRendezvousApprovalBusyGate {
	private readonly listeners = new Set<(busy: boolean) => void>();
	private busy = false;

	isBusy(): boolean {
		return this.busy;
	}

	onDidChangeBusy(listener: (busy: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		for (const listener of [...this.listeners]) {
			listener(busy);
		}
	}
}

class TestManager implements IRendezvousLifecycleManager {
	private readonly completion = deferred<BootstrapRelayCloseReason>();
	private publication: IRendezvousRegistryPublication | undefined;
	private deferredDisposal = false;
	disposeCount = 0;

	constructor(readonly context: IRendezvousLifecycleManagerContext, private readonly number: number, private readonly deferDisposal: boolean) { }

	async start(): Promise<void> {
		this.publication = await this.context.publish({ endpoint: `pipe://bootstrap-${this.number}`, expiresAt: 31_000 });
	}

	whenClosed(): Promise<BootstrapRelayCloseReason> {
		return this.completion.promise;
	}

	dispose(): void {
		this.disposeCount++;
		if (this.deferDisposal) {
			this.deferredDisposal = true;
		} else {
			this.close('disposed');
		}
	}

	close(reason: BootstrapRelayCloseReason): void {
		void this.closeAsync(reason);
	}

	finishDeferredDisposal(): void {
		if (this.deferredDisposal) {
			this.deferredDisposal = false;
			this.close('disposed');
		}
	}

	private async closeAsync(reason: BootstrapRelayCloseReason): Promise<void> {
		await this.publication?.dispose();
		this.completion.resolve(reason);
	}
}

function createFixture(options: { readonly deferManagerDisposal?: boolean } = {}) {
	const registry = new TestRegistry();
	const timers = new TestRelayTimers();
	const leaseTimers = new TestRelayTimers();
	const busy = new TestBusyGate();
	const leases = new DtpTokenLeaseStore({
		timers: leaseTimers,
		now: () => 1_000,
		createTokenBytes: size => Buffer.alloc(size, 7),
		createLeaseId: (() => {
			let next = 1;
			return () => `lease-${next++}`;
		})(),
	});
	const managers: TestManager[] = [];
	let windowNumber = 1;
	let registryNumber = 1;
	const lifecycle = new DelverWindowRendezvousLifecycle({
		registry,
		leases,
		approvalBusyGate: busy,
		createManager: context => {
			const manager = new TestManager(context, managers.length + 1, options.deferManagerDisposal ?? false);
			managers.push(manager);
			return manager;
		},
		createWindowInstanceId: () => `window-instance-${String(windowNumber++).padStart(2, '0')}`,
		createRegistryEntryId: () => `registry-entry-${String(registryNumber++).padStart(2, '0')}`,
		ownerProcessId: 4242,
		now: () => 1_000,
		timers,
		random: () => 0.5,
	});
	return { lifecycle, registry, timers, busy, leases, managers };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(value => resolve = value);
	return { promise, resolve };
}

async function settlePromises(): Promise<void> {
	for (let index = 0; index < 8; index++) {
		await Promise.resolve();
	}
}
