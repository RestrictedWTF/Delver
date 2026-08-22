/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import { DelverAgentBridgeActivation, DelverWorkspaceRendezvousController, IAgentBridgeRuntime, isWorkspaceSelectionEligibleForBridge, IWorkspaceRendezvousLifecycle, IWorkspaceRootSource } from '../productionBridge';
import { IRendezvousRegistry, IRendezvousRegistryEntry, IRendezvousRegistryPublication } from '../rendezvousRegistry';
import { IWorkspaceRootV1Selection } from '../rootFingerprint';

const FINGERPRINT = 'a'.repeat(64);

describe('Production workspace rendezvous controller', () => {
	it('clears the old root and awaits private relay teardown before publishing the new root', async () => {
		const workspace = new TestWorkspace();
		const registry = new TestRegistry();
		const lifecycle = new TestLifecycle();
		const fingerprint = deferred<string>();
		const cleanup = deferred<void>();
		const events: string[] = [];
		const controller = new DelverWorkspaceRendezvousController(
			workspace,
			registry,
			lifecycle,
			'linux',
			() => 100,
			() => {
				events.push('close-private');
				return cleanup.promise;
			},
			async () => fingerprint.promise,
		);
		lifecycle.onSetRoot = root => events.push(`root:${root ?? 'none'}`);

		const started = controller.start();
		assert.deepStrictEqual(events, ['root:none', 'close-private']);
		fingerprint.resolve(FINGERPRINT);
		await settlePromises();
		assert.deepStrictEqual({ events, pruneCalls: registry.pruneCalls }, { events: ['root:none', 'close-private'], pruneCalls: [] });
		cleanup.resolve();
		await started;
		assert.deepStrictEqual({ events, pruneCalls: registry.pruneCalls }, {
			events: ['root:none', 'close-private', `root:${FINGERPRINT}`],
			pruneCalls: [100],
		});
		await controller.dispose();
	});

	it('ignores stale fingerprints and leaves unsupported or disposed workspaces unpublished', async () => {
		const workspace = new TestWorkspace();
		const registry = new TestRegistry();
		const lifecycle = new TestLifecycle();
		const fingerprints = [deferred<string>(), deferred<string>()];
		let computation = 0;
		const controller = new DelverWorkspaceRendezvousController(
			workspace,
			registry,
			lifecycle,
			'linux',
			() => 200,
			async () => { },
			async () => fingerprints[computation++].promise,
		);

		const started = controller.start();
		workspace.emitChange();
		fingerprints[1].resolve('b'.repeat(64));
		await settlePromises();
		fingerprints[0].resolve(FINGERPRINT);
		await started;
		await settlePromises();
		assert.deepStrictEqual(lifecycle.roots, [undefined, undefined, 'b'.repeat(64)]);

		workspace.selection = { roots: [{ scheme: 'file', fsPath: '/root' }], trusted: false };
		workspace.emitChange();
		await settlePromises();
		assert.strictEqual(lifecycle.roots[lifecycle.roots.length - 1], undefined);
		await controller.dispose();
		assert.deepStrictEqual({ disposed: lifecycle.disposeCount, listenerCount: workspace.listenerCount }, { disposed: 1, listenerCount: 0 });
	});
});

describe('Production bridge activation gate', () => {
	it('does not resolve native assets until a trusted local workspace is eligible', async () => {
		const workspace = new TestWorkspace();
		workspace.selection = { roots: [{ scheme: 'file', fsPath: '/root' }], trusted: false };
		const runtimes: TestRuntime[] = [];
		const activation = new DelverAgentBridgeActivation({
			workspace,
			platform: 'linux',
			createRuntime: () => {
				const runtime = new TestRuntime();
				runtimes.push(runtime);
				return runtime;
			},
		});
		await activation.start();
		assert.strictEqual(runtimes.length, 0);

		workspace.selection = { roots: [{ scheme: 'file', fsPath: '/root' }], trusted: true };
		workspace.emitChange();
		await settlePromises();
		assert.deepStrictEqual(runtimes.map(runtime => ({ starts: runtime.startCount, disposals: runtime.disposeCount })), [{ starts: 1, disposals: 0 }]);

		await activation.dispose();
		assert.deepStrictEqual({ disposals: runtimes[0].disposeCount, listenerCount: workspace.listenerCount }, { disposals: 1, listenerCount: 0 });
	});

	it('refuses remote, virtual, untitled, multi-root, untrusted, and unsupported platforms', () => {
		const local = { roots: [{ scheme: 'file', fsPath: '/root' }], trusted: true } as const;
		assert.deepStrictEqual([
			isWorkspaceSelectionEligibleForBridge(local, 'linux'),
			isWorkspaceSelectionEligibleForBridge({ ...local, remoteName: 'ssh' }, 'linux'),
			isWorkspaceSelectionEligibleForBridge({ roots: [{ scheme: 'vscode-remote', fsPath: '/root' }], trusted: true }, 'linux'),
			isWorkspaceSelectionEligibleForBridge({ ...local, workspaceFileScheme: 'untitled' }, 'linux'),
			isWorkspaceSelectionEligibleForBridge({ roots: [...local.roots, ...local.roots], trusted: true }, 'linux'),
			isWorkspaceSelectionEligibleForBridge({ ...local, trusted: false }, 'linux'),
			isWorkspaceSelectionEligibleForBridge(local, 'aix'),
		], [true, false, false, false, false, false, false]);
	});

	it('accepts only Windows UNC authorities that match the filesystem root', () => {
		const root = { scheme: 'file', authority: 'server', fsPath: '\\\\SERVER\\SHARE\\Project' };
		assert.deepStrictEqual([
			isWorkspaceSelectionEligibleForBridge({ roots: [root], trusted: true }, 'win32'),
			isWorkspaceSelectionEligibleForBridge({ roots: [{ ...root, authority: 'other' }], trusted: true }, 'win32'),
			isWorkspaceSelectionEligibleForBridge({ roots: [{ ...root, authority: 'servér' }], trusted: true }, 'win32'),
		], [true, false, false]);
	});
});

class TestWorkspace implements IWorkspaceRootSource {
	private readonly listeners = new Set<() => void>();
	selection: IWorkspaceRootV1Selection = { roots: [{ scheme: 'file', fsPath: '/root' }], trusted: true };

	get listenerCount(): number { return this.listeners.size; }

	getSelection(): IWorkspaceRootV1Selection { return this.selection; }

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitChange(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

class TestLifecycle implements IWorkspaceRendezvousLifecycle {
	readonly roots: (string | undefined)[] = [];
	onSetRoot: (root: string | undefined) => void = () => { };
	disposeCount = 0;

	start(): void { }

	setRoot(root: string | undefined): void {
		this.roots.push(root);
		this.onSetRoot(root);
	}

	dispose(): void { this.disposeCount++; }

	async whenDisposed(): Promise<void> { }
}

class TestRuntime implements IAgentBridgeRuntime {
	startCount = 0;
	disposeCount = 0;

	async start(): Promise<void> { this.startCount++; }
	async dispose(): Promise<void> { this.disposeCount++; }
}

class TestRegistry implements IRendezvousRegistry {
	readonly pruneCalls: number[] = [];

	async publish(_entry: IRendezvousRegistryEntry): Promise<IRendezvousRegistryPublication> {
		throw new Error('Unexpected publication.');
	}

	async list(_now: number): Promise<readonly IRendezvousRegistryEntry[]> { return []; }

	async prune(now: number): Promise<void> { this.pruneCalls.push(now); }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => resolve = accept);
	return { promise, resolve };
}

async function settlePromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise<void>(resolve => setImmediate(resolve));
}
