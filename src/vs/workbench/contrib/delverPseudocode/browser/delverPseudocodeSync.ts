/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * Whether moving the pseudocode cursor moves the listing with it.
 *
 * Synchronisation is the product, and it is also the thing that gets in the way:
 * reading decompiled C line by line drags the disassembly along, losing the
 * instruction the analyst was holding. `principles.md` §5 requires every
 * synchronised view to be **defeatable**, visibly — hence a toggle in the zone
 * header rather than a setting.
 *
 * Deliberately one global flag rather than per-widget state. Sync describes the
 * *relationship* between listing and pseudocode, not a property of either, so an
 * analyst who turns it off means it for the pair — including a torn-off
 * pseudocode tab, where per-widget state would be most confusing.
 *
 * Only the pseudocode → listing direction is affected. Selecting an address in
 * the listing still moves pseudocode, because that is navigation the analyst
 * just performed; pin is what stops that (§5's "reason, not origin" rule).
 */
export const DELVER_PSEUDOCODE_SYNC = new RawContextKey<boolean>('delverPseudocodeSync', true);

let enabled = true;

const onDidChange = new Emitter<boolean>();

/** Fires when the analyst toggles pseudocode-to-listing synchronisation. */
export const onDidChangePseudocodeSync: Event<boolean> = onDidChange.event;

export function isPseudocodeSyncEnabled(): boolean {
	return enabled;
}

export function setPseudocodeSyncEnabled(value: boolean): void {
	if (enabled === value) {
		return;
	}
	enabled = value;
	onDidChange.fire(value);
}
