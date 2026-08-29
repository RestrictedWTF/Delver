/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IDelverTargetSnapshot } from '../../common/delverProcessService.js';
import { IGetImageInfoResult, TargetCapabilityWire } from '../../common/protocol.generated.js';
import { TargetConfig } from '../../common/target.js';
import { DelverProcessService, IDelverProviderHandle } from '../../node/delverProcessService.js';

/** Stands in for the provider child, counting the releases it is given. */
class FakeProvider implements IDelverProviderHandle {
	disposals = 0;

	readonly descriptor = { name: 'sample.exe', kind: 'file' };
	readonly capabilities = [];
	readonly spaces = [];

	/** Stands for the child actually going away, which the test times. */
	private exit: (() => void) | undefined;
	private readonly exited = new Promise<void>(resolve => { this.exit = resolve; });

	constructor(readonly path: string, private readonly exitsOnDispose = true) { }

	get snapshot(): IDelverTargetSnapshot {
		return {
			descriptor: { name: this.path, kind: 'file' },
			capabilities: [TargetCapabilityWire.GetImageInfo],
			spaces: [],
		};
	}

	async getImageInfo(): Promise<IGetImageInfoResult> {
		throw new Error('not exercised here');
	}

	dispose(): void {
		this.disposals++;
		if (this.exitsOnDispose) {
			this.exit?.();
		}
	}

	async whenExited(): Promise<void> {
		await this.exited;
	}

	/** Grants the exit a test deliberately withheld. */
	release(): void {
		this.exit?.();
	}
}

suite('DelverProcessService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(exitsOnDispose = true) {
		const providers: FakeProvider[] = [];
		const service = store.add(new DelverProcessService(async (config: TargetConfig) => {
			const provider = new FakeProvider(config.path, exitsOnDispose);
			providers.push(provider);
			return provider;
		}));
		return { service, providers };
	}

	test('detaching releases the provider child and announces it', async () => {
		const { service, providers } = createService();
		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveTarget(snapshot => seen.push(snapshot?.descriptor.name)));

		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });
		await service.detach();
		// Detaching twice must not announce a second release.
		await service.detach();

		assert.deepStrictEqual(
			{ disposals: providers.map(p => p.disposals), seen },
			{ disposals: [1], seen: ['C:\\samples\\a.exe', undefined] },
		);
	});

	test('disposing the service releases the provider child', async () => {
		// This is the reload case. The shared process outlives the window, so a
		// child nobody released stays attached with the sample mapped — on
		// Windows that locks the file the analyst is trying to rebuild.
		const { service, providers } = createService();
		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });

		service.dispose();

		assert.deepStrictEqual(providers.map(p => p.disposals), [1]);
	});

	test('attaching again releases the previous child', async () => {
		const { service, providers } = createService();
		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });

		await service.attach({ kind: 'file', path: 'C:\\samples\\b.exe' });

		assert.deepStrictEqual(
			{ disposals: providers.map(p => p.disposals), paths: providers.map(p => p.path) },
			{ disposals: [1, 0], paths: ['C:\\samples\\a.exe', 'C:\\samples\\b.exe'] },
		);
	});

	test('detaching does not settle until the child is really gone', async () => {
		// `detach()` promises the release, not the request for one. A window that
		// is closing has to be able to join the child's exit — otherwise it hands
		// the analyst back a file the provider still has mapped.
		const { service, providers } = createService(false);
		await service.attach({ kind: 'file', path: 'C:\samples\a.exe' });

		let settled = false;
		const detached = service.detach().then(() => { settled = true; });
		await Promise.resolve();
		const settledBeforeExit = settled;
		providers[0].release();
		await detached;

		assert.deepStrictEqual(
			{ settledBeforeExit, settledAfterExit: settled },
			{ settledBeforeExit: false, settledAfterExit: true },
		);
	});

	test('image info without a target reports that rather than answering', async () => {
		const { service } = createService();
		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });
		await service.detach();

		await assert.rejects(() => service.getImageInfo(), /No active target/);
	});
});
