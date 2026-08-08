/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/delverListing.css';
// Registers the listing's semantic colors; the CSS above reads them as variables.
import './delverListingColors.js';

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	DELVER_VIEW_CONTAINER,
	DELVER_VIEW_CONTAINER_ID,
	delverViewIds,
} from '../../../services/delver/browser/delverViewContainer.js';
import {
	IViewDescriptor,
	IViewDescriptorService,
	ViewVisibilityState,
} from '../../../common/views.js';
import { DelverListingEditor } from './delverListingEditor.js';
import { DELVER_LISTING_EDITOR_ID, DelverListingInput } from './delverListingInput.js';
import {
	FollowAction,
	CommentAction,
	GoToAddressAction,
	GoToFunctionAction,
	NavigateBackAction,
	NavigateForwardAction,
	RenameAction,
	ReturnAction,
	TogglePinAction,
} from './delverListingNavigation.js';
import { ExportInterpretationAction, ImportInterpretationAction } from './delverInterpretationActions.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(DelverListingEditor, DELVER_LISTING_EDITOR_ID, localize2('delverListingEditor', "Delver Listing").value),
	[new SyncDescriptor(DelverListingInput)],
);

/**
 * Opens a binary for analysis.
 *
 * **The single entry point.** Opening a target analyses it once and every view
 * reads from that one session — sections, references, and the listing. Attaching
 * for headers and opening a listing were separate commands, which meant two
 * providers on one file and two things to remember before the workspace looked
 * complete.
 */
class OpenTargetAction extends Action2 {
	constructor() {
		super({
			id: 'delver.target.open',
			title: localize2('delverOpenTarget', 'Open Target'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.folderOpened,
			// On the container's title bar, not just in the palette: this is the
			// one thing every session starts with, and a workspace whose primary
			// action is only reachable by typing its name is not discoverable.
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);

		const result = await fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
		});
		if (!result || result.length === 0) {
			return;
		}

		// Bring the workspace into view, without focus — opening a target is
		// what this container is for, and leaving it behind the Explorer means
		// the sections and references that just populated go unseen.
		//
		// The container only: a view the user hid stays hidden, because that was
		// their choice. `Delver: Reset Views` is the way back from it.
		await viewsService.openViewContainer(DELVER_VIEW_CONTAINER_ID, false);

		await editorService.openEditor(new DelverListingInput(result[0].fsPath), { pinned: true });
	}
}

/**
 * Brings back every Delver view.
 *
 * Hiding a view persists and nothing un-hides it, so one stray click on "Hide"
 * silently removes part of the workspace for good — and re-opening a target does
 * not bring it back, which reads as a bug rather than as a setting.
 */
class ResetViewsAction extends Action2 {
	constructor() {
		super({
			id: 'delver.views.reset',
			title: localize2('delverResetViews', 'Reset Views'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.refresh,
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
				group: 'navigation',
				order: 2,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		const viewDescriptorService = accessor.get(IViewDescriptorService);

		// A view's container is remembered per user, not taken from wherever the
		// code last registered it. A view that has ever lived somewhere else —
		// Sections was in the Explorer before Delver had its own container, and
		// a user can drag any view anywhere — stays there, and re-registering it
		// has no effect. So put them back before showing them.
		const strays = delverViewIds()
			.filter(id => viewDescriptorService.getViewContainerByViewId(id) !== DELVER_VIEW_CONTAINER)
			.map(id => viewDescriptorService.getViewDescriptorById(id))
			.filter((descriptor): descriptor is IViewDescriptor => !!descriptor);

		if (strays.length > 0) {
			viewDescriptorService.moveViewsToContainer(strays, DELVER_VIEW_CONTAINER, ViewVisibilityState.Expand);
		}

		await viewsService.openViewContainer(DELVER_VIEW_CONTAINER_ID, false);
		for (const id of delverViewIds()) {
			// `openView` un-hides as well as reveals, which is the point here.
			await viewsService.openView(id, false);
		}
	}
}

/**
 * Opens the listing for the target already open, without a file dialog.
 *
 * The listing is a sibling tab to Strings, so getting back to it has to be as
 * cheap as switching tabs — not a re-open of the same file.
 */
CommandsRegistry.registerCommand('delver.listing.openCurrent', async (accessor: ServicesAccessor) => {
	const session = accessor.get(IDelverSessionService).activeSession;
	if (session) {
		await accessor.get(IEditorService).openEditor(new DelverListingInput(session.targetPath), { pinned: true });
	}
});

registerAction2(OpenTargetAction);
registerAction2(ResetViewsAction);
registerAction2(GoToAddressAction);
registerAction2(GoToFunctionAction);
registerAction2(NavigateBackAction);
registerAction2(NavigateForwardAction);
registerAction2(TogglePinAction);
registerAction2(FollowAction);
registerAction2(ReturnAction);
registerAction2(RenameAction);
registerAction2(CommentAction);
registerAction2(ExportInterpretationAction);
registerAction2(ImportInterpretationAction);
