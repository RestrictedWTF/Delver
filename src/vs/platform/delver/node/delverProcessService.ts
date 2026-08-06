/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { IDelverProcessService, IDelverTargetSnapshot } from '../common/delverProcessService.js';
import { IAddressSpace } from '../common/address.js';
import { TargetCapability } from '../common/capabilities.js';
import { IGetImageInfoResult } from '../common/protocol.generated.js';
import { TargetConfig } from '../common/target.js';
import { DelverProviderProcess } from './providerProcess.js';

export class DelverProcessService implements IDelverProcessService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveTarget = new Emitter<IDelverTargetSnapshot | undefined>();
	readonly onDidChangeActiveTarget = this._onDidChangeActiveTarget.event;

	private target: DelverProviderProcess | undefined;

	async attach(config: TargetConfig): Promise<IDelverTargetSnapshot> {
		this.detach();
		this.target = await DelverProviderProcess.attach(config);
		const snapshot = snapshotFromInit(this.target.descriptor, this.target.capabilities, this.target.spaces);
		this._onDidChangeActiveTarget.fire(snapshot);
		return snapshot;
	}

	async getImageInfo(): Promise<IGetImageInfoResult> {
		if (!this.target) {
			throw new Error('No active target');
		}
		return this.target.getImageInfo();
	}

	detach(): void {
		if (this.target) {
			this.target.dispose();
			this.target = undefined;
			this._onDidChangeActiveTarget.fire(undefined);
		}
	}
}

function snapshotFromInit(
	descriptor: { name: string; kind: string },
	capabilities: readonly TargetCapability[],
	spaces: readonly IAddressSpace[],
): IDelverTargetSnapshot {
	return { descriptor, capabilities, spaces };
}
