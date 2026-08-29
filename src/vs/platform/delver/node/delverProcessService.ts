/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { IDelverProcessService, IDelverTargetSnapshot } from '../common/delverProcessService.js';
import { IGetImageInfoResult } from '../common/protocol.generated.js';
import { IDelverTarget, TargetConfig } from '../common/target.js';
import { DelverProviderProcess } from './providerProcess.js';

/**
 * An attached provider, as this service uses it.
 *
 * Named separately from {@link DelverProviderProcess} so the child process is a
 * dependency that can be substituted, rather than something the service reaches
 * for by name.
 */
export interface IDelverProviderHandle extends IDelverTarget {
	readonly snapshot: IDelverTargetSnapshot;

	/**
	 * Settles once the child is really gone.
	 *
	 * Optional because `IDelverTarget` disposal is synchronous, so a handle that
	 * owns no process has nothing to wait for. A handle that does own one uses
	 * this to make {@link IDelverProcessService.detach} mean what it says.
	 */
	whenExited?(): Promise<void>;
}

export type DelverProviderFactory = (config: TargetConfig) => Promise<IDelverProviderHandle>;

export class DelverProcessService extends Disposable implements IDelverProcessService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveTarget = this._register(new Emitter<IDelverTargetSnapshot | undefined>());
	readonly onDidChangeActiveTarget = this._onDidChangeActiveTarget.event;

	/**
	 * The attached provider, held by a disposable rather than a plain field.
	 *
	 * The child keeps the sample mapped for as long as it lives — on Windows
	 * that locks the file the analyst is working on — so its lifetime has to end
	 * with this service, not only with a `detach()` someone remembered to call.
	 */
	private readonly provider = this._register(new MutableDisposable<IDelverProviderHandle>());

	constructor(
		private readonly spawnProvider: DelverProviderFactory = config => DelverProviderProcess.attach(config),
	) {
		super();
	}

	async attach(config: TargetConfig): Promise<IDelverTargetSnapshot> {
		await this.detach();
		const provider = await this.spawnProvider(config);
		this.provider.value = provider;
		const snapshot = provider.snapshot;
		this._onDidChangeActiveTarget.fire(snapshot);
		return snapshot;
	}

	async getImageInfo(): Promise<IGetImageInfoResult> {
		const provider = this.provider.value;
		if (!provider) {
			throw new Error('No active target');
		}
		return provider.getImageInfo();
	}

	async detach(): Promise<void> {
		const provider = this.provider.value;
		if (!provider) {
			return;
		}
		this.provider.clear();
		this._onDidChangeActiveTarget.fire(undefined);
		// `clear()` only asks the child to go. Awaiting its real exit is what
		// makes this method's contract true: a caller that reattaches, or a
		// window that is closing, must not race a provider still holding the
		// sample mapped. The wait is bounded by the provider's own escalation.
		await provider.whenExited?.();
	}
}
