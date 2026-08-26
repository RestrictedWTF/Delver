/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IDelverWorkspaceService = createDecorator<IDelverWorkspaceService>('delverWorkspaceService');

export interface IDelverWorkspaceService {
	readonly _serviceBrand: undefined;
	readonly onDidRequestSurface: Event<string>;
	showSurface(id: string): void;
}

/** Broadcasts explicit UI navigation into whichever target workspace is active. */
export class DelverWorkspaceService extends Disposable implements IDelverWorkspaceService {
	readonly _serviceBrand: undefined;

	private readonly _onDidRequestSurface = this._register(new Emitter<string>());
	readonly onDidRequestSurface = this._onDidRequestSurface.event;

	showSurface(id: string): void {
		this._onDidRequestSurface.fire(id);
	}
}

registerSingleton(IDelverWorkspaceService, DelverWorkspaceService, InstantiationType.Delayed);
