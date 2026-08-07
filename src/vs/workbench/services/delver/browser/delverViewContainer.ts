/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions,
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
} from '../../../common/views.js';

/**
 * The Delver activity-bar container.
 *
 * Every Delver view lives here rather than in the Explorer. Reverse engineering
 * is the whole task, not an accessory to editing files: sections, references,
 * and everything Stage F and G add belong together and next to each other, and
 * borrowing another feature's container would scatter them.
 *
 * This lives in `services/delver/` rather than in a contribution because more
 * than one contribution registers views into it, and a contribution must not
 * import another contribution's internals.
 */

export const DELVER_VIEW_CONTAINER_ID = 'workbench.view.delver';

const delverViewIcon = registerIcon(
	'delver-view-icon',
	Codicon.circuitBoard,
	localize('delverViewIcon', 'View icon of the Delver view container.'),
);

export const DELVER_VIEW_CONTAINER: ViewContainer = Registry
	.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: DELVER_VIEW_CONTAINER_ID,
		title: localize2('delver', "Delver"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			DELVER_VIEW_CONTAINER_ID,
			// Keep the container's own title even with one view showing: the
			// views arrive progressively as stages land, and a container that
			// renames itself to whichever view happens to be visible is
			// disorienting.
			{ mergeViewWithContainerWhenSingleView: false },
		]),
		icon: delverViewIcon,
		// After the built-in containers. Delver is the point of this build, but
		// displacing Explorer would fight muscle memory for no gain.
		order: 6,
		// Kept visible even before a target is attached, so the views are
		// discoverable rather than appearing only once something is open.
		hideIfEmpty: false,
	}, ViewContainerLocation.Sidebar);

const registeredViewIds: string[] = [];

/**
 * Registers a view into the Delver container and records it in the roster.
 *
 * The roster exists so a command can bring every Delver view back without any
 * contribution having to know about another's view ids. Hiding a view persists,
 * and nothing un-hides it — so without a way back, one stray click on "Hide"
 * permanently removes part of the workspace.
 */
export function registerDelverView(descriptor: IViewDescriptor): void {
	registeredViewIds.push(descriptor.id);
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry)
		.registerViews([descriptor], DELVER_VIEW_CONTAINER);
}

/** Every view registered into the Delver container, in registration order. */
export function delverViewIds(): readonly string[] {
	return registeredViewIds;
}
