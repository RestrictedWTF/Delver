/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Delayer } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ITreeView } from '../../../common/views.js';
import { ITreeViewDescriptor } from '../../../common/views.js';
import { delverTreeFilterProvider } from './delverFilterableTreeViewPane.js';
import { DelverZone, IDelverSurface } from './delverSurface.js';
import { registerDelverSurface } from './delverSurfaceRegistry.js';

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

	/**
	 * The element `show()` was given — not the zone container, which may hold a
	 * filter row above it. The disposal guard compares against this, so it has to
	 * be the same element `treeView.container` will report.
	 */
	private treeContainer: HTMLElement | undefined;
	private filterRow: HTMLElement | undefined;
	private readonly filterDelayer = this._register(new Delayer<void>(120));

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
			if (this.treeContainer && this.treeView.container === this.treeContainer) {
				this.treeView.setVisibility(false);
			}
		}));
	}

	render(container: HTMLElement): void {
		const provider = delverTreeFilterProvider(this.treeView);
		if (!provider) {
			this.treeContainer = container;
			this.treeView.show(container);
			return;
		}
		this.filterRow = dom.append(container, dom.$('.delver-tree-filter'));
		const input = dom.append(this.filterRow, dom.$('input.delver-tree-filter-input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = localize('delverFilterSurface', "Filter");
		input.ariaLabel = localize('delverFilterSurfaceAria', "Filter view contents");
		const treeContainer = dom.append(container, dom.$('.delver-filterable-tree'));
		this.treeContainer = treeContainer;
		this._register(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			void this.filterDelayer.trigger(async () => {
				provider.setFilter(input.value);
				await this.treeView.refresh();
				if (input.value.trim()) {
					const roots = await this.treeView.dataProvider?.getChildren();
					if (roots) {
						await this.treeView.expand([...roots]);
					}
				}
			}).catch(onUnexpectedError);
		}));
		this.treeView.show(treeContainer);
	}

	layout(dimension: Dimension): void {
		const filterHeight = this.filterRow?.offsetHeight || (this.filterRow ? 34 : 0);
		this.treeView.layout(Math.max(0, dimension.height - filterHeight), dimension.width);
	}

	setVisible(visible: boolean): void {
		this.treeView.setVisibility(visible);
	}

	focus(): void {
		this.treeView.focus();
	}
}

/** Migrates an existing tree-view contribution into a workspace segment. */
export function registerDelverTreeSurface(
	id: string,
	zone: DelverZone,
	descriptor: ITreeViewDescriptor,
	badge?: Event<number | undefined>,
): IDisposable {
	return registerDelverSurface({
		id,
		title: descriptor.name,
		zone,
		order: descriptor.order ?? 0,
		when: descriptor.when,
		ctor: new SyncDescriptor(DelverTreeSurface, [descriptor.treeView]),
		badge,
	});
}
