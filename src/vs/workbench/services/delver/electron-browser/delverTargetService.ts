/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { IDelverProcessService } from '../../../../platform/delver/common/delverProcessService.js';
import { IDelverTarget, TargetConfig } from '../../../../platform/delver/common/target.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDelverTargetService } from '../common/delverTargetService.js';

class DelverTarget implements IDelverTarget {
	constructor(
		readonly descriptor: IDelverTarget['descriptor'],
		readonly capabilities: IDelverTarget['capabilities'],
		readonly spaces: IDelverTarget['spaces'],
		private readonly processService: IDelverProcessService,
	) { }

	getImageInfo() {
		return this.processService.getImageInfo();
	}

	dispose() {
		this.processService.detach();
	}
}

export class DelverTargetService implements IDelverTargetService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveTarget = new Emitter<IDelverTarget | undefined>();
	readonly onDidChangeActiveTarget = this._onDidChangeActiveTarget.event;

	private _activeTarget: IDelverTarget | undefined;

	constructor(
		@IDelverProcessService private readonly processService: IDelverProcessService,
	) {
		processService.onDidChangeActiveTarget(snapshot => {
			if (!snapshot) {
				this._activeTarget = undefined;
			} else {
				this._activeTarget = new DelverTarget(snapshot.descriptor, snapshot.capabilities, snapshot.spaces, processService);
			}
			this._onDidChangeActiveTarget.fire(this._activeTarget);
		});
	}

	get activeTarget(): IDelverTarget | undefined {
		return this._activeTarget;
	}

	async attach(config: TargetConfig): Promise<IDelverTarget> {
		const snapshot = await this.processService.attach(config);
		this._activeTarget = new DelverTarget(snapshot.descriptor, snapshot.capabilities, snapshot.spaces, this.processService);
		this._onDidChangeActiveTarget.fire(this._activeTarget);
		return this._activeTarget;
	}

	detach(): void {
		this.processService.detach();
	}
}

registerSingleton(IDelverTargetService, DelverTargetService, InstantiationType.Delayed);
