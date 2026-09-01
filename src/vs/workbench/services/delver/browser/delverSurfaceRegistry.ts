/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IDelverFocus } from '../common/delverFocusService.js';
import { DelverZone, IDelverSurface } from './delverSurface.js';

export interface IDelverSurfaceContext {
	readonly targetPath: string;
	readonly focus: IDelverFocus;
	readonly functionRva?: bigint;
	readonly functionName?: string;
}

export interface IDelverSurfaceDescriptor<T extends IDelverSurface = IDelverSurface> {

	/** `delver.surface.<name>`. */
	readonly id: string;

	readonly title: ILocalizedString;

	readonly zone: DelverZone;

	/** Position within the zone. Ties break by id so the order is stable. */
	readonly order: number;

	/** Capability gate, evaluated when the zone builds its segment list. */
	readonly when?: ContextKeyExpression;

	readonly ctor: SyncDescriptor<T>;

	/**
	 * Surfaces shown beside this one, under this one's tab.
	 *
	 * Listing and Pseudocode are always read together — selecting either showed
	 * both — so presenting them as two tabs claimed a choice the analyst does not
	 * actually have. A companion gets no tab of its own and is never selectable
	 * alone; it appears and disappears with its host.
	 */
	readonly companions?: readonly string[];

	/**
	 * Contribution-owned binding from workspace state to this surface.
	 *
	 * The workspace deliberately does not downcast widgets or assume that a
	 * target, session, and cursor are the same kind of input. See the context
	 * binding decision in `Docs/design/workspace.md` §3.
	 */
	readonly setContext?: (surface: T, context: IDelverSurfaceContext, token: CancellationToken) => Promise<void> | void;

	/** Stable key for the subset of context consumed by `setContext`. */
	readonly contextKey?: (context: IDelverSurfaceContext) => string;

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
	readonly tearOff?: (context: IDelverSurfaceContext) => EditorInput | undefined;
}

export class DelverSurfaceRegistry extends Disposable {

	private readonly surfaces = new Map<string, IDelverSurfaceDescriptor>();
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	register<T extends IDelverSurface>(descriptor: IDelverSurfaceDescriptor<T>): IDisposable {
		if (this.surfaces.has(descriptor.id)) {
			throw new Error(`A Delver surface with id '${descriptor.id}' is already registered.`);
		}

		const erased: IDelverSurfaceDescriptor = {
			...descriptor,
			ctor: descriptor.ctor as SyncDescriptor<IDelverSurface>,
			setContext: descriptor.setContext
				? (surface, context, token) => descriptor.setContext!(surface as T, context, token)
				: undefined,
		};
		this.surfaces.set(descriptor.id, erased);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this.surfaces.get(descriptor.id) === erased) {
				this.surfaces.delete(descriptor.id);
				this._onDidChange.fire();
			}
		});
	}

	all(): readonly IDelverSurfaceDescriptor[] {
		return [...this.surfaces.values()];
	}
}

const registry = new DelverSurfaceRegistry();

/**
 * Registers a surface.
 *
 * This indirection exists because the workspace hosts surfaces owned by
 * `delverFunctions`, `delverXrefs` and the rest, and invariant 9 forbids it
 * from importing any of them. It replaces `registerDelverView` in
 * `delverViewContainer.ts`, which existed for the same reason.
 */
export function registerDelverSurface<T extends IDelverSurface>(descriptor: IDelverSurfaceDescriptor<T>): IDisposable {
	return registry.register(descriptor);
}

/** Every registered surface, in registration order. */
export function allDelverSurfaces(): readonly IDelverSurfaceDescriptor[] {
	return registry.all();
}

/** Fires when a surface registers or unregisters. */
export const onDidChangeDelverSurfaces = registry.onDidChange;

/**
 * The surfaces belonging to one zone, in display order.
 *
 * Takes its input rather than reading the registry so it can be tested without
 * a global; the registry is only ever the caller.
 */
export function surfacesForZone(
	all: readonly IDelverSurfaceDescriptor[],
	zone: DelverZone,
	matches: (expression: ContextKeyExpression) => boolean = () => true,
): readonly IDelverSurfaceDescriptor[] {
	return all
		.filter(surface => surface.zone === zone && (!surface.when || matches(surface.when)))
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The zone that would show `id`, or `undefined` if nothing would.
 *
 * Exported because a reveal is only real if the id it names resolves to a
 * registered surface: `IDelverWorkspaceService.showSurface` is fire-and-forget,
 * so an id that resolves nowhere — a leftover *view* id, say, of the kind that
 * left three shipped reveal actions silent no-ops — fails invisibly. Routing
 * and its tests share this one lookup so that cannot drift apart again.
 */
export function zoneForSurface(all: readonly IDelverSurfaceDescriptor[], id: string): DelverZone | undefined {
	for (const zone of [DelverZone.Navigator, DelverZone.Inspector, DelverZone.Primary]) {
		if (surfacesForZone(all, zone).some(surface => surface.id === id)) {
			return zone;
		}
	}
	return undefined;
}

/** Ids that appear under another surface's tab rather than owning one. */
export function companionSurfaceIds(all: readonly IDelverSurfaceDescriptor[]): ReadonlySet<string> {
	const companions = new Set<string>();
	for (const surface of all) {
		for (const id of surface.companions ?? []) {
			companions.add(id);
		}
	}
	return companions;
}
