/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * An anchor for authored interpretation.
 *
 * Annotations attach to `(contentHash, rva)` rather than absolute addresses so
 * they survive rebasing.
 */
export interface IAnchor {
	readonly contentHash: Uint8Array;
	readonly rva: bigint;
}
