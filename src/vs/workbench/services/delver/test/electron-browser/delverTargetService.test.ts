/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelverProcessService, IDelverTargetSnapshot } from '../../../../../platform/delver/common/delverProcessService.js';
import { IGetImageInfoResult, TargetCapabilityWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { TargetConfig } from '../../../../../platform/delver/common/target.js';
import { TestLifecycleService } from '../../../../test/common/workbenchTestServices.js';
import { DelverTargetService } from '../../electron-browser/delverTargetService.js';

/** Stands in for the shared process, counting the releases it is asked for. */
class FakeProcessService extends Disposable implements IDelverProcessService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveTarget = this._register(new Emitter<IDelverTargetSnapshot | undefined>());
	readonly onDidChangeActiveTarget = this._onDidChangeActiveTarget.event;

	detaches = 0;
	attachedPath: string | undefined;

	async attach(config: TargetConfig): Promise<IDelverTargetSnapshot> {
		this.attachedPath = config.path;
		return {
			descriptor: { name: config.path, kind: 'file' },
			capabilities: [TargetCapabilityWire.GetImageInfo],
			spaces: [],
		};
	}

	async getImageInfo(): Promise<IGetImageInfoResult> {
		throw new Error('not exercised here');
	}

	async detach(): Promise<void> {
		this.detaches++;
		this.attachedPath = undefined;
	}
}

suite('DelverTargetService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService() {
		const processService = store.add(new FakeProcessService());
		const lifecycle = store.add(new TestLifecycleService());
		const service = store.add(new DelverTargetService(processService, lifecycle));
		return { service, processService, lifecycle };
	}

	test('shutdown releases the provider, and joins the release', async () => {
		// The provider lives in the shared process, which survives a window
		// reload. Left attached it keeps the sample mapped — on Windows that
		// locks the file under analysis — and an unjoined release does not
		// outlive the window it was sent from.
		const { service, processService, lifecycle } = createService();
		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });

		lifecycle.fireShutdown();
		const joiners = lifecycle.shutdownJoiners.length;
		await Promise.all(lifecycle.shutdownJoiners);

		assert.deepStrictEqual(
			{ joiners, detaches: processService.detaches, attached: processService.attachedPath },
			{ joiners: 1, detaches: 1, attached: undefined },
		);
	});

	test('disposing the service releases the provider', async () => {
		const { service, processService } = createService();
		await service.attach({ kind: 'file', path: 'C:\\samples\\a.exe' });

		service.dispose();

		assert.deepStrictEqual(
			{ detaches: processService.detaches, active: service.activeTarget?.descriptor.name },
			{ detaches: 1, active: 'C:\\samples\\a.exe' },
		);
	});
});
