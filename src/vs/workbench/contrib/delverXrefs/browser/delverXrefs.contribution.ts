/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry } from '../../../common/views.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { registerDelverView } from '../../../services/delver/browser/delverViewContainer.js';
import { registerInterpretationViewActions } from '../../../services/delver/browser/delverInterpretationEditing.js';
import {
	DELVER_XREFS_OPEN_COMMAND,
	DELVER_XREFS_VIEW_ID,
	DelverXrefsTreeDataProvider,
} from './delverXrefsView.js';

const viewName = localize2('delverXrefs', "References");

/** Identifies this view on the focus bus, so it ignores its own echo. */
const FOCUS_ORIGIN = 'delver.view.xrefs';

/**
 * Shows what reaches, and is reached by, the current focus.
 *
 * Follows the focus bus rather than the listing directly, so it works for any
 * view that publishes a location.
 */
class DelverXrefsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverFocusService focusService: IDelverFocusService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
		@IDelverInterpretationService interpretationService: IDelverInterpretationService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_XREFS_VIEW_ID, viewName.value);
		const dataProvider = new DelverXrefsTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_XREFS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			// Follows the cursor, so it has to be visible to be of any use.
			collapsed: false,
			order: 70,
		};
		registerDelverView(viewDescriptor);

		viewsRegistry.registerViewWelcomeContent(DELVER_XREFS_VIEW_ID, {
			content: localize(
				'delverXrefsNoTargetWelcome',
				"Open a target to inspect its references.\n[Open Target](command:delver.target.open)",
			),
			when: DELVER_TARGET_OPEN.toNegated(),
		});
		viewsRegistry.registerViewWelcomeContent(DELVER_XREFS_VIEW_ID, {
			content: localize(
				'delverXrefsNoAddressWelcome',
				"Select an address in the listing to see its incoming and outgoing references.",
			),
			when: DELVER_TARGET_OPEN,
		});

		/** Guards against a slow lookup overwriting a newer one. */
		let generation = 0;
		let functionGeneration = 0;
		let functions: readonly IFunctionWire[] = [];
		let names = new Map<bigint, string>();

		const loadFunctions = async () => {
			const session = sessionService.activeSession;
			const token = ++functionGeneration;
			functions = [];
			names = new Map();
			dataProvider.setFunctions(functions);
			dataProvider.setNames(names);
			if (!session) {
				treeView.refresh().catch(onUnexpectedError);
				return;
			}
			try {
				const result = await sessionService.functions();
				if (token !== functionGeneration) {
					return;
				}
				functions = result.functions;
				names = interpretationService.namesFor(session.contentHash, functions.map(fn => BigInt(fn.rva)));
				dataProvider.setFunctions(functions);
				dataProvider.setNames(names);
				treeView.refresh().catch(onUnexpectedError);
			} catch (error) {
				if (token === functionGeneration) {
					onUnexpectedError(error);
				}
			}
		};

		sessionService.onDidChangeActiveSession(() => {
			generation++;
			dataProvider.setContent(undefined);
			treeView.refresh().catch(onUnexpectedError);
			void loadFunctions();
		});
		interpretationService.onDidChange(event => {
			const session = sessionService.activeSession;
			if (!session || event.edit.op !== EditOp.Rename || event.edit.anchor.contentHash !== session.contentHash) {
				return;
			}
			const rva = event.edit.anchor.rva;
			const name = interpretationService.nameAt(event.edit.anchor);
			if (name === undefined) {
				names.delete(rva);
			} else {
				names.set(rva, name);
			}
			dataProvider.setNames(names);
			treeView.refresh().catch(onUnexpectedError);
		});

		if (sessionService.activeSession) {
			loadFunctions();
		}

		// Deliberately not filtered by origin. Clicking a reference here moves
		// the focus, and this panel must then show references for where it just
		// sent everyone — unlike a view that scrolls, answering a question about
		// a new address cannot feed back into another focus change.
		focusService.onDidChangeFocus(async e => {
			const session = sessionService.activeSession;
			const location = e.focus.location;
			const token = ++generation;

			if (!session || !location || !session.sessionId) {
				dataProvider.setContent(undefined);
				treeView.refresh().catch(onUnexpectedError);
				return;
			}

			const address = `0x${location.address.toString(16).toUpperCase()}`;
			try {
				const [to, from] = await Promise.all([
					analysisService.xrefsTo(session.sessionId, address),
					analysisService.xrefsFrom(session.sessionId, address),
				]);
				// Focus moves faster than these round trips; a stale answer
				// arriving late would show references for somewhere the user has
				// already left.
				if (token !== generation) {
					return;
				}
				dataProvider.setContent({ address, to: to.xrefs, from: from.xrefs });
			} catch (error) {
				if (token !== generation) {
					return;
				}
				dataProvider.setContent(undefined);
				onUnexpectedError(error);
			}
			treeView.refresh().catch(onUnexpectedError);
		});
	}
}

registerWorkbenchContribution2(
	'delver.xrefsView',
	DelverXrefsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_XREFS_OPEN_COMMAND, (accessor: ServicesAccessor, address: string) => {
	// Published with this view's own origin so the panel does not immediately
	// re-query for the address it just sent everyone to.
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(address) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
});

registerInterpretationViewActions({
	commandPrefix: 'delver.xrefs',
	viewId: DELVER_XREFS_VIEW_ID,
	contextValue: 'delver-xref',
});
