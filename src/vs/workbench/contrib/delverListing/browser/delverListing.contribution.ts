/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/delverListing.css';
// Registers the listing's semantic colors; the CSS above reads them as variables.
import './delverListingColors.js';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { DELVER_TARGET_ATTACHED, DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
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
import { DelverPseudocodeInput } from '../../delverPseudocode/browser/delverPseudocodeInput.js';
import { DelverStringsInput } from '../../delverStrings/browser/delverStringsInput.js';
import {
	CommentAction,
	DecompileFunctionAction,
	FollowAction,
	GoToAddressAction,
	GoToFunctionAction,
	NavigateBackAction,
	NavigateForwardAction,
	RenameAction,
	RevertAuthorAction,
	ReturnAction,
	TagAction,
	TogglePinAction,
	UndoInterpretationAction,
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
		const dialogService = accessor.get(IDialogService);
		const editorService = accessor.get(IEditorService);
		const viewsService = accessor.get(IViewsService);
		const sessionService = accessor.get(IDelverSessionService);
		const projectOpenServices = { dialogService, editorService, viewsService, sessionService };

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

		const targetPath = result[0].fsPath;
		if (targetPath.toLowerCase().endsWith('.delverdb')) {
			await openDelverProject(projectOpenServices, targetPath);
			return;
		}
		let forceReload = false;
		if (sessionService.activeSession?.targetPath === targetPath) {
			try {
				await sessionService.refreshTarget(targetPath);
				forceReload = true;
			} catch (error) {
				if (isCancellationError(error)) {
					return;
				}
				throw error;
			}
		}

		const pane = await editorService.openEditor(new DelverListingInput(targetPath), { pinned: true, forceReload });
		if (pane) {
			await closeDelverEditors(editorService, editor => editor !== pane.input && targetPathForDelverEditor(editor) !== targetPath);
		}
	}
}

/** Opens a portable SQLite project without treating it as target bytes. */
class OpenProjectAction extends Action2 {
	constructor() {
		super({
			id: 'delver.project.open',
			title: localize2('delverOpenProject', 'Open Project'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.database,
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
				group: 'navigation',
				order: 2,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const services: IDelverProjectOpenServices = {
			dialogService: accessor.get(IDialogService),
			editorService: accessor.get(IEditorService),
			viewsService: accessor.get(IViewsService),
			sessionService: accessor.get(IDelverSessionService),
		};
		const result = await fileDialogService.showOpenDialog({
			title: localize2('delverOpenProjectDialog', 'Open Delver Project').value,
			openLabel: localize2('delverOpenProjectLabel', 'Open Project').value,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: localize2('delverProjectFileFilter', 'Delver Project').value, extensions: ['delverdb'] }],
			availableFileSystems: ['file'],
		});
		if (result?.[0]) {
			await openDelverProject(services, result[0].fsPath);
		}
	}
}

interface IDelverProjectOpenServices {
	readonly dialogService: IDialogService;
	readonly editorService: IEditorService;
	readonly viewsService: IViewsService;
	readonly sessionService: IDelverSessionService;
}

async function openDelverProject(services: IDelverProjectOpenServices, projectPath: string): Promise<void> {
	try {
		await services.sessionService.openProject(projectPath);
		await closeDelverEditors(services.editorService, () => true);
		await services.viewsService.openViewContainer(DELVER_VIEW_CONTAINER_ID, false);
	} catch (error) {
		if (!isCancellationError(error)) {
			await services.dialogService.error(
				localize2('delverOpenProjectFailed', 'Could Not Open Delver Project').value,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

/** Saves the active analysis to its current project or asks for a project name. */
class SaveProjectAction extends Action2 {
	constructor() {
		super({
			id: 'delver.project.save',
			title: localize2('delverSaveProject', 'Save Project'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.save,
			precondition: DELVER_TARGET_OPEN,
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
					DELVER_TARGET_OPEN,
				),
				group: 'navigation',
				order: 3,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IDelverSessionService).saveProject();
	}
}

/** Locates the original bytes for live operations in an offline project. */
class LocateTargetAction extends Action2 {
	constructor() {
		super({
			id: 'delver.project.locateTarget',
			title: localize2('delverLocateTarget', 'Locate Target'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.fileBinary,
			precondition: ContextKeyExpr.and(DELVER_TARGET_OPEN, DELVER_TARGET_ATTACHED.toNegated()),
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
					DELVER_TARGET_OPEN,
					DELVER_TARGET_ATTACHED.toNegated(),
				),
				group: 'navigation',
				order: 4,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const sessionService = accessor.get(IDelverSessionService);
		const dialogService = accessor.get(IDialogService);
		const result = await fileDialogService.showOpenDialog({
			title: localize2('delverLocateTargetDialog', 'Locate Matching Target').value,
			openLabel: localize2('delverAttachTargetLabel', 'Attach Target').value,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
		});
		if (!result?.[0]) {
			return;
		}
		try {
			await sessionService.attachTarget(result[0].fsPath);
		} catch (error) {
			await dialogService.error(
				localize2('delverAttachTargetFailed', 'Could Not Attach Target').value,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

/** Explicitly closes the active Delver project and all editors that could reopen it. */
class CloseProjectAction extends Action2 {
	constructor() {
		super({
			id: 'delver.project.close',
			title: localize2('delverCloseProject', 'Close Project'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
			icon: Codicon.close,
			precondition: DELVER_TARGET_OPEN,
			menu: [{
				id: MenuId.ViewContainerTitle,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('viewContainer', DELVER_VIEW_CONTAINER_ID),
					DELVER_TARGET_OPEN,
				),
				group: 'navigation',
				order: 5,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const sessionService = accessor.get(IDelverSessionService);
		const editorService = accessor.get(IEditorService);
		if (!await sessionService.closeTarget()) {
			return;
		}
		await closeDelverEditors(editorService, () => true);
	}
}

function targetPathForDelverEditor(editor: DelverListingInput | DelverPseudocodeInput | DelverStringsInput): string {
	return editor.targetPath;
}

async function closeDelverEditors(editorService: IEditorService, predicate: (editor: DelverListingInput | DelverPseudocodeInput | DelverStringsInput) => boolean): Promise<void> {
	const editors = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(identifier => {
		const editor = identifier.editor;
		return (editor instanceof DelverListingInput || editor instanceof DelverPseudocodeInput || editor instanceof DelverStringsInput)
			&& predicate(editor);
	});
	if (editors.length > 0) {
		await editorService.closeEditors(editors, { preserveFocus: true });
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
				order: 6,
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

/** Opens the sole portable project found anywhere in the local workspace. */
class DelverProjectAutoOpenContribution {
	constructor(
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IDialogService dialogService: IDialogService,
		@IEditorService editorService: IEditorService,
		@IViewsService viewsService: IViewsService,
		@IDelverSessionService sessionService: IDelverSessionService,
	) {
		void this.autoOpen(workspaceContextService, searchService, {
			dialogService,
			editorService,
			viewsService,
			sessionService,
		}).catch(onUnexpectedError);
	}

	private async autoOpen(
		workspaceContextService: IWorkspaceContextService,
		searchService: ISearchService,
		services: IDelverProjectOpenServices,
	): Promise<void> {
		if (services.sessionService.activeSession) {
			return;
		}
		const folders = workspaceContextService.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
		if (folders.length === 0) {
			return;
		}
		const result = await searchService.fileSearch({
			type: QueryType.File,
			folderQueries: folders.map(folder => ({ folder: folder.uri })),
			filePattern: '**/*.delverdb',
			shouldGlobMatchFilePattern: true,
			maxResults: 2,
		}, CancellationToken.None);
		if (result.results.length !== 1 || services.sessionService.activeSession) {
			return;
		}
		await openDelverProject(services, result.results[0].resource.fsPath);
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
registerAction2(OpenProjectAction);
registerAction2(SaveProjectAction);
registerAction2(LocateTargetAction);
registerAction2(CloseProjectAction);
registerAction2(ResetViewsAction);
registerAction2(GoToAddressAction);
registerAction2(GoToFunctionAction);
registerAction2(NavigateBackAction);
registerAction2(NavigateForwardAction);
registerAction2(TogglePinAction);
registerAction2(FollowAction);
registerAction2(DecompileFunctionAction);
registerAction2(ReturnAction);
registerAction2(RenameAction);
registerAction2(CommentAction);
registerAction2(TagAction);
registerAction2(UndoInterpretationAction);
registerAction2(RevertAuthorAction);
registerAction2(ExportInterpretationAction);
registerAction2(ImportInterpretationAction);

registerWorkbenchContribution2(
	'delver.projectAutoOpen',
	DelverProjectAutoOpenContribution,
	WorkbenchPhase.AfterRestored,
);
