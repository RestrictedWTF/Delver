/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IDelverFocus } from '../common/delverFocusService.js';
import { DelverZone, IDelverSurface } from './delverSurface.js';

export interface IDelverSurfaceDescriptor {

	/** `delver.surface.<name>`. */
	readonly id: string;

	readonly title: ILocalizedString;

	readonly zone: DelverZone;

	/** Position within the zone. Ties break by id so the order is stable. */
	readonly order: number;

	/** Capability gate, evaluated when the zone builds its segment list. */
	readonly when?: ContextKeyExpression;

	readonly ctor: SyncDescriptor<IDelverSurface>;

	/**
	 * Count shown on the segment tab. Load-bearing for Review: a proposal queue
	 * that is invisible until its tab is clicked is a queue that goes
	 * unreviewed. See `Docs/design/workspace.md` §6.
	 */
	readonly badge?: Event<number | undefined>;

	/**
	 * Opens this surface as a real editor tab. Optional: only surfaces with a
	 * comparison workflow need it.
	 */
	readonly tearOff?: (focus: IDelverFocus) => EditorInput;
}

const surfaces: IDelverSurfaceDescriptor[] = [];

/**
 * Registers a surface.
 *
 * This indirection exists because the workspace hosts surfaces owned by
 * `delverFunctions`, `delverXrefs` and the rest, and invariant 9 forbids it
 * from importing any of them. It replaces `registerDelverView` in
 * `delverViewContainer.ts`, which existed for the same reason.
 */
export function registerDelverSurface(descriptor: IDelverSurfaceDescriptor): void {
	surfaces.push(descriptor);
}

/** Every registered surface, in registration order. */
export function allDelverSurfaces(): readonly IDelverSurfaceDescriptor[] {
	return surfaces;
}

/**
 * The surfaces belonging to one zone, in display order.
 *
 * Takes its input rather than reading the registry so it can be tested without
 * a global; the registry is only ever the caller.
 */
export function surfacesForZone(
	all: readonly IDelverSurfaceDescriptor[],
	zone: DelverZone,
): readonly IDelverSurfaceDescriptor[] {
	return all
		.filter(surface => surface.zone === zone)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
