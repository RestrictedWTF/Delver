/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * What a listing action needs, independent of what is hosting the listing.
 *
 * Actions used to reach the listing with `instanceof DelverListingEditor`
 * against the active editor pane. Once a listing can also be a segment of a
 * workspace zone, that test finds nothing and Follow, Pin, and Generate
 * Signature quietly stop working. This interface is the seam.
 */
export interface IDelverListingHost {
	togglePin(): void;
	followSelection(): void;
	selectedFunctionRva(): Promise<bigint | undefined>;
}

/**
 * A stack, not a single slot. Two listings can be open at once — one in a zone,
 * one torn off for comparison — and disposing the one that is not on top must
 * not silently hand actions to a disposed widget.
 */
const hosts: IDelverListingHost[] = [];

/** Marks `host` as the one actions apply to. Dispose when it loses focus. */
export function setActiveListing(host: IDelverListingHost): IDisposable {
	hosts.push(host);
	return toDisposable(() => {
		const index = hosts.lastIndexOf(host);
		if (index !== -1) {
			hosts.splice(index, 1);
		}
	});
}

/** The listing that actions apply to, or `undefined` if none is focused. */
export function activeListing(): IDelverListingHost | undefined {
	return hosts.length ? hosts[hosts.length - 1] : undefined;
}
