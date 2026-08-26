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
	IViewContainersRegistry,
	ViewContainer,
	ViewContainerLocation,
} from '../../../common/views.js';

export const DELVER_VIEW_CONTAINER_ID = 'workbench.view.delver';

const delverViewIcon = registerIcon(
	'delver-view-icon',
	Codicon.circuitBoard,
	localize('delverViewIcon', 'View icon of the Delver view container.'),
);

/**
 * The Delver activity-bar container.
 *
 * It shows exactly one view — the target launcher. Every analysis surface now
 * lives in the workspace editor ([ADR 0007](../../../../../../Docs/history/adr/0007-workspace-editor-over-sidebar-container.md)),
 * and this container survives because an activity-bar entry *is* a view
 * container upstream: `PaneCompositeBar` builds its items from
 * `viewDescriptorService.getViewContainers()`.
 *
 * It lives in `services/` rather than in the workspace contribution because
 * `registerDelverTreeSurface` also needs it, and a service may not import a
 * contribution (invariant 9).
 */
export const DELVER_VIEW_CONTAINER: ViewContainer = Registry
	.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer({
		id: DELVER_VIEW_CONTAINER_ID,
		title: localize2('delver', "Delver"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			DELVER_VIEW_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		icon: delverViewIcon,
		order: 6,
		hideIfEmpty: false,
	}, ViewContainerLocation.Sidebar);
