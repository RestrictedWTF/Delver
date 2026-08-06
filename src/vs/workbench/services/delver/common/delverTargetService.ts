/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IDelverTarget, TargetConfig } from '../../../../platform/delver/common/target.js';

export const IDelverTargetService = createDecorator<IDelverTargetService>('delverTargetService');

export interface IDelverTargetService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the active target changes.
	 */
	readonly onDidChangeActiveTarget: Event<IDelverTarget | undefined>;

	/**
	 * The currently attached target, if any.
	 */
	readonly activeTarget: IDelverTarget | undefined;

	/**
	 * Attaches to a target using the supplied configuration.
	 */
	attach(config: TargetConfig): Promise<IDelverTarget>;

	/**
	 * Detaches from the active target and releases the provider.
	 */
	detach(): void;
}
