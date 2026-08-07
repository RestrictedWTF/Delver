/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import {
	IAddressSpaceWire,
	IGetImageInfoResult,
	ITargetDescriptorWire,
	TargetCapabilityWire,
} from './protocol.generated.js';
import { TargetConfig } from './target.js';

export const IDelverProcessService = createDecorator<IDelverProcessService>('delverProcessService');

/**
 * Target state as it crosses the shared-process → renderer boundary.
 *
 * **This is wire-shaped on purpose.** VS Code's IPC serializes object payloads
 * with `JSON.stringify`, which throws on `bigint` — and the throw happens
 * inside the channel server's promise callback, so no response is ever sent
 * and the caller's promise never settles. A domain `IAddressSpace` here (its
 * `size` is a `bigint`) hangs `attach()` forever with no error anywhere.
 *
 * So this boundary follows the same rule as DTP: u64 travels as a "0x..."
 * string (ADR 0001) and is converted to `bigint` on the renderer edge via
 * `addressSpaceFromWire`.
 */
export interface IDelverTargetSnapshot {
	readonly descriptor: ITargetDescriptorWire;
	readonly capabilities: readonly TargetCapabilityWire[];
	readonly spaces: readonly IAddressSpaceWire[];
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
