/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kind of moment represented by a target read.
 */
export const enum MomentKind {
	Static = 'static',
	Snapshot = 'snapshot',
	Live = 'live',
}

/**
 * A point in time at which target data was observed.
 */
export interface IMoment {
	readonly kind: MomentKind;
	readonly epoch: bigint;
}

/**
 * The constant moment used by static providers.
 */
export const STATIC_MOMENT: IMoment = Object.freeze({
	kind: MomentKind.Static,
	epoch: 0n,
});
