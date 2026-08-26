/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import {
	Extensions as ViewExtensions,
	ITreeViewDescriptor,
	IViewsRegistry,
} from '../../../common/views.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { DelverOverviewTreeDataProvider, DELVER_OVERVIEW_GO_TO_COMMAND, DELVER_OVERVIEW_REVEAL_COMMAND } from './delverOverviewView.js';

export const DELVER_OVERVIEW_VIEW_ID = 'delver.view.overview';

const viewName = localize2('delverOverview', "Overview");

class DelverOverviewViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_OVERVIEW_VIEW_ID, viewName.value);
		const dataProvider = new DelverOverviewTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_OVERVIEW_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 10,
		};
		registerDelverTreeSurface(DelverSurfaceId.Overview, DelverZone.Primary, viewDescriptor);

		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_OVERVIEW_VIEW_ID,
			{
				content: localize(
					'delverOverviewWelcome',
					"No target open.\n[Open Target](command:delver.target.open)",
				),
				when: DELVER_TARGET_OPEN.toNegated(),
			},
		);

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				treeView.message = undefined;
				dataProvider.setContent(undefined, undefined, undefined);
			} else {
				try {
					const info = await sessionService.imageInfo();
					if (token !== generation) {
						return;
					}
					treeView.message = undefined;
					dataProvider.setContent(session.targetPath, session.image, info);
				} catch (error) {
					if (token !== generation) {
						return;
					}
					// This runs on a session change, so the rows on screen belong to
					// whatever was open before. Keeping them would attribute one
					// binary's file name, entry point and counts to another, and
					// every row here navigates — into the *new* session. Drop them
					// and say why instead.
					dataProvider.setContent(undefined, undefined, undefined);
					treeView.message = localize(
						'delverOverviewFailed',
						"Could not load the overview: {0}",
						toErrorMessage(error),
					);
					onUnexpectedError(error);
				}
			}
			treeView.refresh().catch(onUnexpectedError);
		};

		sessionService.onDidChangeActiveSession(() => update());

		if (sessionService.activeSession) {
			update();
		}
	}
}

registerWorkbenchContribution2(
	'delver.overviewView',
	DelverOverviewViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_OVERVIEW_GO_TO_COMMAND, (accessor: ServicesAccessor, rva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		'delver.view.overview',
		FocusReason.User,
	);
});

CommandsRegistry.registerCommand(DELVER_OVERVIEW_REVEAL_COMMAND, async (accessor: ServicesAccessor, viewId: string) => {
	// Reveals rather than toggles: a row that hides the pane you just asked for
	// would be a trap, since Overview does not show whether it is already open.
	await accessor.get(IViewsService).openView(viewId, false);
});
