/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry } from '../../../common/views.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { DelverFilterableTreeViewPane, registerDelverTreeFilterProvider } from '../../../services/delver/browser/delverFilterableTreeViewPane.js';
import { registerInterpretationViewActions } from '../../../services/delver/browser/delverInterpretationEditing.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import {
	DELVER_IMPORTS_OPEN_COMMAND,
	DELVER_IMPORTS_VIEW_ID,
	DelverImportsTreeDataProvider,
} from './delverImportsView.js';

const viewName = localize2('delverImports', "Imports");

/** Identifies this view on the focus bus. */
const FOCUS_ORIGIN = 'delver.view.imports';

/**
 * What the open image imports, grouped by module.
 *
 * For an unknown binary this is the highest-signal pane available: the set of
 * libraries and APIs a file reaches for says more in one glance than a thousand
 * instructions do.
 */
class DelverImportsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_IMPORTS_VIEW_ID, viewName.value);
		const dataProvider = new DelverImportsTreeDataProvider();
		treeView.dataProvider = dataProvider;
		registerDelverTreeFilterProvider(treeView, dataProvider);

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_IMPORTS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(DelverFilterableTreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 30,
		};
		registerDelverTreeSurface(DelverSurfaceId.Imports, DelverZone.Primary, viewDescriptor);

		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_IMPORTS_VIEW_ID,
			{
				content: localize(
					'delverImportsWelcome',
					"No target open.\n[Open Target](command:delver.target.open)",
				),
				when: DELVER_TARGET_OPEN.toNegated(),
			},
		);

		// Importing nothing is unusual and worth saying plainly — a statically
		// linked or shellcode-style payload looks exactly like this.
		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_IMPORTS_VIEW_ID,
			{
				content: localize('delverImportsEmpty', "This image imports nothing."),
				when: DELVER_TARGET_OPEN,
			},
		);

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				treeView.message = undefined;
				dataProvider.setImports(undefined);
			} else {
				try {
					const result = await sessionService.imports();
					if (token !== generation) {
						return;
					}
					treeView.message = undefined;
					dataProvider.setImports(result);
				} catch (error) {
					if (token !== generation) {
						return;
					}
					// The session has already changed, so the modules on screen are
					// the previous target's. Left up they would read as this image's
					// imports — the single highest-signal claim this pane makes —
					// and the "imports nothing" welcome would be just as false. Both
					// are avoided by showing the reason instead.
					dataProvider.setImports(undefined);
					treeView.message = localize(
						'delverImportsFailed',
						"Could not load the imports: {0}",
						toErrorMessage(error),
					);
					onUnexpectedError(error);
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
	'delver.importsView',
	DelverImportsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_IMPORTS_OPEN_COMMAND, (accessor: ServicesAccessor, iatRva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(iatRva) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
});

registerInterpretationViewActions({
	commandPrefix: 'delver.imports',
	viewId: DELVER_IMPORTS_VIEW_ID,
	contextValue: 'delver-import-symbol',
});
