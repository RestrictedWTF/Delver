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

	private container: HTMLElement | undefined;

	constructor(private readonly treeView: ITreeView) {
		super();

		// `TreeView.domNode` is built in `create()`, which runs only from
		// `initialize()`, which runs only from `setVisibility()`. Calling
		// `show()` before that appends `undefined` — and because `Node.append`
		// stringifies, it silently renders the literal text "undefined" and the
		// real tree is never attached. `TreeViewPane` forces initialization the
		// same way from its own constructor, before `renderBody()` reaches
		// `show()`; this is that step, not an idle default.
		this.treeView.setVisibility(false);

		this._register(toDisposable(() => {
			// A tree view is a singleton owned by the views registry and shared
			// between hosts, and `show()` re-parents it. Hide it only while it
			// is still ours: during the migration a `TreeViewPane` and a zone
			// surface can both wrap one view, and an unguarded teardown would
			// hide the tree the surviving host just took over.
			if (this.container && this.treeView.container === this.container) {
				this.treeView.setVisibility(false);
			}
		}));
	}

	render(container: HTMLElement): void {
		this.container = container;
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
