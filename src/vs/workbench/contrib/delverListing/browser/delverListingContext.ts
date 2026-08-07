/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { FocusReason } from '../../../services/delver/common/delverFocusService.js';
import { DELVER_LISTING_EDITOR_ID } from './delverListingInput.js';

/**
 * Shared context for the listing contribution.
 *
 * Its own module so the editor and the commands that act on it can both use
 * these without importing each other.
 */

/** True while a listing is the active editor. */
export const LISTING_ACTIVE = ContextKeyExpr.equals(ActiveEditorContext.key, DELVER_LISTING_EDITOR_ID);

/** True while the active listing is pinned. Drives the toolbar toggle. */
export const DELVER_LISTING_PINNED = new RawContextKey<boolean>('delverListingPinned', false);

/** Origin used by the navigation commands on the focus bus. */
export const DELVER_NAVIGATION_ORIGIN = 'delver.navigation';

/**
 * Whether a pinned view should still move for a focus change with this reason.
 *
 * Pin exists to stop a view being moved by things the user did not just do — an
 * agent walking xrefs, a script, a target event stopping on a breakpoint. That
 * is a distinction of **reason, not origin**: a reference clicked in the xrefs
 * panel comes from a different view but is unmistakably the user asking to go
 * somewhere, and refusing it would make pin feel broken rather than protective.
 *
 * Publishing is unaffected either way: pin means "do not move me", not "do not
 * speak".
 */
export function shouldFollowWhilePinned(reason: FocusReason): boolean {
	return reason === FocusReason.User || reason === FocusReason.Navigation;
}
