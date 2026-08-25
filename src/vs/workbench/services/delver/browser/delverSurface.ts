/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Which question a surface answers, and therefore where it lives.
 *
 * Not a user preference — see `Docs/design/workspace.md` §2. Navigator answers
 * "what exists in this binary", Primary "what am I reading", Inspector "what
 * does the cursor touch".
 */
export enum DelverZone {
	Navigator = 'navigator',
	Primary = 'primary',
	Inspector = 'inspector',
}

/**
 * A Delver surface: a plain widget, deliberately neither a `ViewPane` nor an
 * `EditorPane`, so that a workspace zone and a tear-off editor can host the
 * same instance type.
 *
 * The shape is chosen to match upstream's `ITreeView` (`show`/`layout`/
 * `setVisibility`), because eight of Delver's eleven surfaces are tree views
 * and adapting them must stay near-free.
 */
export interface IDelverSurface extends IDisposable {

	/**
	 * Attach this surface's DOM under `container`. Called exactly once, and
	 * before the first `layout`, `setVisible`, or `focus`.
	 *
	 * **An implementation must be ready to render at construction time.** A host
	 * is free to call `render` before it has ever called `setVisible`, so a
	 * surface that builds its DOM lazily on first show has to force that work in
	 * its constructor. This is not hypothetical: `TreeView` builds its `domNode`
	 * inside `setVisibility`, so `DelverTreeSurface` must initialize eagerly or
	 * `show` silently attaches nothing.
	 */
	render(container: HTMLElement): void;

	layout(dimension: Dimension): void;

	/**
	 * Told when the surface stops being the visible segment of its zone, so it
	 * can stop responding to the focus bus and release paged data.
	 */
	setVisible(visible: boolean): void;

	focus(): void;
}

/**
 * Deliberately absent: how a surface is pointed at what it should show.
 *
 * `DelverListingWidget.setTarget(path, token)` is the only such method today and
 * it sits outside this interface, because the shape a zone actually needs is not
 * yet known — Navigator surfaces follow the session, Primary surfaces follow the
 * focus bus, and Inspector surfaces follow the cursor. Phase 2 decides that and
 * either adds it here or splits the contract. Until then a host that drives a
 * specific surface downcasts, and that is a known gap rather than an oversight.
 */
