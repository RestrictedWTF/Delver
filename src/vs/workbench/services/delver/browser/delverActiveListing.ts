/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
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

const onDidChange = new Emitter<void>();

/**
 * Fires when the stack changes — a listing appeared, went away, or came to the
 * top.
 *
 * Exists so the context key describing "a listing is live" can be owned by a
 * workbench contribution. Bound from a widget instead, it lands in the context
 * key service scoped to that editor's group, and keybinding resolution — which
 * evaluates `when` against whatever element has DOM focus — cannot see it from
 * anywhere else in the window.
 */
export const onDidChangeActiveListing: Event<void> = onDidChange.event;

/** Marks `host` as the one actions apply to. Dispose when it loses focus. */
export function setActiveListing(host: IDelverListingHost): IDisposable {
	hosts.push(host);
	onDidChange.fire();
	return toDisposable(() => {
		const index = hosts.lastIndexOf(host);
		if (index !== -1) {
			hosts.splice(index, 1);
			onDidChange.fire();
		}
	});
}

/**
 * Promotes an already-registered host to the top, on focus.
 *
 * Registration alone tracks *visibility*, and editor-pane visibility is
 * per-group: two side-by-side groups showing listings are both visible at once,
 * and nothing reorders them when the user clicks between them. Without this,
 * `activeListing()` returns whichever listing was shown last rather than the one
 * being looked at — so Follow, Decompile, and Generate Signature would act on
 * the other pane, silently and with plausible-looking results. Comparing two
 * functions side by side is the workflow this module exists for, so it is
 * precisely the case that must be right.
 *
 * A no-op for an unregistered host: focus does not grant membership.
 */
export function touchActiveListing(host: IDelverListingHost): void {
	const index = hosts.lastIndexOf(host);
	if (index !== -1 && index !== hosts.length - 1) {
		hosts.splice(index, 1);
		hosts.push(host);
		onDidChange.fire();
	}
}

/** The listing that actions apply to, or `undefined` if none is focused. */
export function activeListing(): IDelverListingHost | undefined {
	return hosts.length ? hosts[hosts.length - 1] : undefined;
}
