/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

const outPath = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'vs', 'platform', 'delver', 'common', 'protocol.generated.ts');

const content = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// GENERATED — DO NOT EDIT
// Generated from delver/schema/protocol.schema.json by \`npm run delver:protocol\`.

/**
 * A JSON-RPC style request.
 */
export interface IRequest {
	id: number;
	method: string;
	params: unknown;
}

/**
 * A JSON-RPC style response.
 */
export interface IResponse {
	id: number;
	result?: unknown;
	error?: IRpcError;
}

/**
 * JSON-RPC error object extended with Delver-specific error data.
 */
export interface IRpcError {
	code: number;
	message: string;
	data?: IErrorData;
}

/**
 * Domain-level error kinds.
 */
export const enum ErrorKind {
	ProtocolVersionMismatch = 'ProtocolVersionMismatch',
	NotAttached = 'NotAttached',
	InvalidAddress = 'InvalidAddress',
	UnreadableMemory = 'UnreadableMemory',
	UnsupportedCapability = 'UnsupportedCapability',
	TargetBusy = 'TargetBusy',
}

/**
 * Structured detail carried by a domain error.
 */
export interface IErrorData {
	kind: ErrorKind;
	detail: string;
}

/**
 * Response payload for \`initialize\`.
 */
export interface IInitializeResult {
	protocol_version: string;
	capabilities: TargetCapabilityWire[];
	spaces: IAddressSpaceWire[];
	target: ITargetDescriptorWire;
}

/**
 * Response payload for \`listSpaces\`.
 */
export interface IListSpacesResult {
	spaces: IAddressSpaceWire[];
}

/**
 * Response payload for \`getImageInfo\`.
 */
export interface IGetImageInfoResult {
	arch: string;
	entry: string;
	image_base: string;
	sections: ISectionWire[];
}

/**
 * Parameters for \`readMemory\`.
 */
export interface IReadMemoryParams {
	space: string;
	address: string;
	len: number;
	moment?: IMomentWire;
}

/**
 * Response payload for \`readMemory\`.
 */
export interface IReadMemoryResult {
	data: IFrameRef;
	valid: IRangeWire[];
	served_moment: IMomentWire;
}

/**
 * Reference to a binary frame delivered inline after a JSON response.
 */
export interface IFrameRef {
	['$frame']: number;
	len: number;
}

/**
 * A readable byte range.
 */
export interface IRangeWire {
	start: string;
	end: string;
}

/**
 * A moment on the wire.
 */
export interface IMomentWire {
	kind: MomentKindWire;
	epoch: number;
}

/**
 * Address space kind on the wire.
 */
export const enum AddressSpaceKindWire {
	File = 'file',
	Image = 'image',
}

/**
 * Moment kind on the wire.
 */
export const enum MomentKindWire {
	Static = 'static',
	Snapshot = 'snapshot',
	Live = 'live',
}

/**
 * Target capability on the wire.
 */
export const enum TargetCapabilityWire {
	ListSpaces = 'listSpaces',
	GetImageInfo = 'getImageInfo',
	ReadMemory = 'readMemory',
}

/**
 * Address space on the wire.
 */
export interface IAddressSpaceWire {
	id: string;
	kind: AddressSpaceKindWire;
	pointer_width: number;
	translates_to?: string;
}

/**
 * Image section on the wire.
 */
export interface ISectionWire {
	name: string;
	virtual_address: string;
	virtual_size: number;
	raw_offset: string;
	raw_size: number;
}

/**
 * High-level target descriptor on the wire.
 */
export interface ITargetDescriptorWire {
	name: string;
	kind: string;
}
`;

fs.writeFileSync(outPath, content);
console.log(`Wrote ${outPath}`);
