/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IAddressSpace } from './address.js';
import { TargetCapability } from './capabilities.js';
import { IGetImageInfoResult } from './protocol.generated.js';
import { ITargetDescriptor, TargetConfig } from './target.js';

export const IDelverProcessService = createDecorator<IDelverProcessService>('delverProcessService');

export interface IDelverTargetSnapshot {
	readonly descriptor: ITargetDescriptor;
	readonly capabilities: readonly TargetCapability[];
	readonly spaces: readonly IAddressSpace[];
}

/**
 * Process-side service that runs in a node-capable process (shared process) and
 * communicates with a Delver provider binary.
 */
export interface IDelverProcessService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeActiveTarget: Event<IDelverTargetSnapshot | undefined>;

	attach(config: TargetConfig): Promise<IDelverTargetSnapshot>;
	getImageInfo(): Promise<IGetImageInfoResult>;
	detach(): void;
}
