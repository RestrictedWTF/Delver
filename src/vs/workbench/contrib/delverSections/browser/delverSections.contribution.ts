/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry } from '../../../common/views.js';
import { registerDelverView } from '../../../services/delver/browser/delverViewContainer.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import {
	DELVER_SECTIONS_OPEN_COMMAND,
	DELVER_SECTIONS_VIEW_ID,
	DelverSectionsTreeDataProvider,
} from './delverSectionsView.js';

const viewName = localize2('delverSections', "Sections");

/**
 * Shows the sections of the image the workbench currently has open.
 *
 * Driven by the **active analysis session**, not by an attach of its own.
 * Opening a target once has to populate everything: a sections list that needs
 * its own command, and runs its own provider to answer, is a second copy of the
 * same image and a second thing for the user to remember.
 */
class DelverSectionsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_SECTIONS_VIEW_ID, viewName.value);
		const dataProvider = instantiationService.createInstance(DelverSectionsTreeDataProvider);
		treeView.dataProvider = dataProvider;

		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_SECTIONS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			// Structural rather than browsed: consulted when a question comes up,
			// not read on open. Collapsed keeps the panes that answer "what is
			// this" above the fold.
			collapsed: true,
			order: 60,
		};
		registerDelverView(viewDescriptor);

		// Without this the container opens onto empty trees and reads as broken
		// rather than as waiting for a target.
		viewsRegistry.registerViewWelcomeContent(DELVER_SECTIONS_VIEW_ID, {
			content: localize(
				'delverSectionsWelcome',
				"No target open.\n[Open Target](command:delver.target.open)",
			),
			when: DELVER_TARGET_OPEN.toNegated(),
		});

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				dataProvider.setImageInfo(undefined);
			} else {
				try {
					const info = await analysisService.imageInfo(session.sessionId);
					if (token !== generation) {
						return;
					}
					dataProvider.setImageInfo(info);
				} catch (error) {
					if (token !== generation) {
						return;
					}
					// Leave the previous contents alone rather than blanking the
					// view: a failed refresh is not evidence the image changed.
					onUnexpectedError(error);
					return;
				}
			}
			treeView.refresh().catch(onUnexpectedError);
		};

		sessionService.onDidChangeActiveSession(() => update());

		// A session may already be open when this contribution constructs.
		if (sessionService.activeSession) {
			update();
		}
	}
}

registerWorkbenchContribution2(
	'delver.sectionsView',
	DelverSectionsViewContribution,
	WorkbenchPhase.AfterRestored
);

CommandsRegistry.registerCommand(DELVER_SECTIONS_OPEN_COMMAND, (accessor: ServicesAccessor, rva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		'delver.view.sections',
		FocusReason.User,
	);
});
