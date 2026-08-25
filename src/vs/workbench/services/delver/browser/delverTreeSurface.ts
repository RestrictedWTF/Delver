/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ITreeView } from '../../../common/views.js';
import { IDelverSurface } from './delverSurface.js';

/**
 * Hosts an upstream `ITreeView` as a Delver surface.
 *
 * Eight of Delver's eleven surfaces are tree views over a `TreeDataProvider`,
 * and `ITreeView` already exposes `show`/`layout`/`setVisibility`. The surface
 * contract was shaped to match, so this adapter stays trivial and the data
 * providers — where the actual logic lives — need no changes at all.
 *
 * `TreeViewPane` is the equivalent adapter for the `ViewPane` host; this is its
 * counterpart for a workspace zone.
 */
export class DelverTreeSurface extends Disposable implements IDelverSurface {

	constructor(private readonly treeView: ITreeView) {
		super();
		// A disposed surface must stop responding to the focus bus. Without
		// this, a zone that swapped segments leaves a dead tree reacting to
		// navigation it will never render.
		this._register(toDisposable(() => this.treeView.setVisibility(false)));
	}

	render(container: HTMLElement): void {
		this.treeView.show(container);
	}

	layout(dimension: Dimension): void {
		this.treeView.layout(dimension.height, dimension.width);
	}

	setVisible(visible: boolean): void {
		this.treeView.setVisibility(visible);
	}

	focus(): void {
		this.treeView.focus();
	}
}
