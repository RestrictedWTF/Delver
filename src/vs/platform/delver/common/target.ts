/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAddressSpace } from './address.js';
import { TargetCapability } from './capabilities.js';
import { IGetImageInfoResult } from './protocol.generated.js';

/**
 * High-level target descriptor.
 */
export interface ITargetDescriptor {
	readonly name: string;
	readonly kind: string;
}

/**
 * Configuration used to attach to a file-backed target.
 */
export interface IFileTargetConfig {
	readonly kind: 'file';
	readonly path: string;
}

/**
 * Union of all target attachment configurations.
 */
export type TargetConfig = IFileTargetConfig;

/**
 * An attached Delver target.
 */
export interface IDelverTarget {
	readonly descriptor: ITargetDescriptor;
	readonly capabilities: readonly TargetCapability[];
	readonly spaces: readonly IAddressSpace[];

	/**
	 * Returns image metadata if the target supports it.
	 */
	getImageInfo(): Promise<IGetImageInfoResult>;

	/**
	 * Releases the target and terminates the provider process.
	 */
	dispose(): void;
}
