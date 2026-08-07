/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { IDelverProcessService, IDelverTargetSnapshot } from '../../../../platform/delver/common/delverProcessService.js';
import { IDelverTarget, TargetConfig } from '../../../../platform/delver/common/target.js';
import { addressSpaceFromWire, capabilitiesFromWire, descriptorFromWire } from '../../../../platform/delver/common/wire.js';
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

	/**
	 * Last snapshot broadcast to listeners, kept to recognise an echo.
	 *
	 * `attach()` learns the new target from its own return value, and the shared
	 * process also broadcasts the same change as an event. Both arrive, so
	 * without this every attach notifies twice and every listener does its work
	 * twice — which previously meant two concurrent `getImageInfo` calls.
	 */
	private applied: IDelverTargetSnapshot | undefined;

	constructor(
		@IDelverProcessService private readonly processService: IDelverProcessService,
	) {
		processService.onDidChangeActiveTarget(snapshot => this.apply(snapshot));
	}

	get activeTarget(): IDelverTarget | undefined {
		return this._activeTarget;
	}

	async attach(config: TargetConfig): Promise<IDelverTarget> {
		return this.apply(await this.processService.attach(config))!;
	}

	detach(): void {
		this.processService.detach();
	}

	/**
	 * Adopts a snapshot and notifies listeners, ignoring a repeat of the change
	 * that was last broadcast. Returns the current target either way.
	 */
	private apply(snapshot: IDelverTargetSnapshot | undefined): IDelverTarget | undefined {
		if (sameSnapshot(this.applied, snapshot)) {
			return this._activeTarget;
		}

		this.applied = snapshot;
		this._activeTarget = snapshot ? this.targetFromSnapshot(snapshot) : undefined;
		this._onDidChangeActiveTarget.fire(this._activeTarget);
		return this._activeTarget;
	}

	/**
	 * Converts a snapshot from its wire form. This is the renderer edge: past
	 * this point addresses and sizes are `bigint`, never strings.
	 */
	private targetFromSnapshot(snapshot: IDelverTargetSnapshot): DelverTarget {
		return new DelverTarget(
			descriptorFromWire(snapshot.descriptor),
			capabilitiesFromWire(snapshot.capabilities),
			snapshot.spaces.map(addressSpaceFromWire),
			this.processService,
		);
	}
}

/**
 * Whether two snapshots describe the same attached target.
 *
 * This only has to recognise the echo of a change that was just broadcast, and
 * `attach` always detaches first — so a real change is always separated from the
 * previous one by an `undefined`. That is what makes a shallow comparison
 * sufficient here, and it is why the target kind plays no part in it.
 */
function sameSnapshot(a: IDelverTargetSnapshot | undefined, b: IDelverTargetSnapshot | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return (
		a.descriptor.name === b.descriptor.name &&
		a.capabilities.length === b.capabilities.length &&
		a.capabilities.every((c, i) => c === b.capabilities[i]) &&
		a.spaces.length === b.spaces.length &&
		a.spaces.every((s, i) => s.id === b.spaces[i].id && s.size === b.spaces[i].size)
	);
}

registerSingleton(IDelverTargetService, DelverTargetService, InstantiationType.Delayed);
