/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Address-space kinds exposed by a Delver target.
 */
export const enum AddressSpaceKind {
	File = 'file',
	Image = 'image',
}

/**
 * Identifies an address space within a target. In TypeScript this is a plain
 * string (e.g. "File" or "Image") to keep serialization simple; the Rust side
 * uses a newtype.
 */
export type SpaceId = string;

/**
 * Description of an address space.
 */
export interface IAddressSpace {
	readonly id: SpaceId;
	readonly kind: AddressSpaceKind;
	readonly pointerWidth: number;
	readonly translatesTo: SpaceId | undefined;
}

/**
 * A concrete location: an address within an address space.
 */
export interface ILocation {
	readonly space: SpaceId;
	readonly address: bigint;
}

/**
 * A readable byte range, inclusive start and exclusive end.
 */
export interface IRange {
	readonly start: bigint;
	readonly end: bigint;
}
