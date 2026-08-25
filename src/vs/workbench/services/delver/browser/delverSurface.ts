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
	 * Attach this surface's DOM under `container`. Called exactly once, before
	 * the first `layout`.
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
