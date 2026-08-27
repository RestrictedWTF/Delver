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
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { DELVER_TARGET_ATTACHED, DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverWorkspaceService } from '../../../services/delver/common/delverWorkspaceService.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverSurface } from '../../../services/delver/browser/delverSurfaceRegistry.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { DELVER_CAN_GO_BACK, DELVER_CAN_GO_FORWARD, DELVER_LISTING_FOCUSED } from './delverListingContext.js';
import { activeListing, onDidChangeActiveListing } from './delverActiveListing.js';
import { EditorExtensions, EditorsOrder } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISearchService, QueryType } from '../../../services/search/common/search.js';
import { DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { DelverListingEditor } from './delverListingEditor.js';
import { DELVER_LISTING_EDITOR_ID, DelverListingInput } from './delverListingInput.js';
import { DelverListingWidget } from './delverListingWidget.js';
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
	RedoInterpretationAction,
} from './delverListingNavigation.js';
import { ExportInterpretationAction, ImportInterpretationAction } from './delverInterpretationActions.js';
import { GenerateSignatureAction } from './delverSignatureActions.js';

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
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const dialogService = accessor.get(IDialogService);
		const editorService = accessor.get(IEditorService);
		const sessionService = accessor.get(IDelverSessionService);
		const projectOpenServices = { dialogService, editorService, sessionService };

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

		// Opens alongside whatever is already open. This used to sweep closed
		// every Delver editor belonging to another target -- the third place the
		// single-target assumption was encoded, after the session service and the
		// input's Singleton capability (ADR 0008). Editors now close with their
		// own target, not when a different one opens.
		await editorService.openEditor(new DelverWorkspaceInput(targetPath), { pinned: true, forceReload });
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
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const services: IDelverProjectOpenServices = {
			dialogService: accessor.get(IDialogService),
			editorService: accessor.get(IEditorService),
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
	readonly sessionService: IDelverSessionService;
}

async function openDelverProject(services: IDelverProjectOpenServices, projectPath: string): Promise<void> {
	try {
		await services.sessionService.openProject(projectPath);
		const pane = await services.editorService.openEditor(new DelverWorkspaceInput(projectPath), { pinned: true });
		if (pane) {
			await closeDelverEditors(services.editorService, editor => editor !== pane.input);
		}
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

async function closeDelverEditors(editorService: IEditorService, predicate: (editor: EditorInput) => boolean): Promise<void> {
	const editors = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(identifier => {
		const editor = identifier.editor;
		return editor.typeId.startsWith('delver.input.') && predicate(editor);
	});
	if (editors.length > 0) {
		await editorService.closeEditors(editors, { preserveFocus: true });
	}
}

/** Opens the sole portable project found anywhere in the local workspace. */
class DelverProjectAutoOpenContribution {
	constructor(
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IDialogService dialogService: IDialogService,
		@IEditorService editorService: IEditorService,
		@IDelverSessionService sessionService: IDelverSessionService,
	) {
		void this.autoOpen(workspaceContextService, searchService, {
			dialogService,
			editorService,
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
		await accessor.get(IEditorService).openEditor(new DelverWorkspaceInput(session.projectPath ?? session.targetPath), { pinned: true });
		accessor.get(IDelverWorkspaceService).showSurface(DelverSurfaceId.Listing);
	}
});

registerAction2(OpenTargetAction);
registerAction2(OpenProjectAction);
registerAction2(SaveProjectAction);
registerAction2(LocateTargetAction);
registerAction2(CloseProjectAction);
registerAction2(GoToAddressAction);
registerAction2(GoToFunctionAction);
registerAction2(NavigateBackAction);
registerAction2(NavigateForwardAction);
registerAction2(TogglePinAction);
registerAction2(FollowAction);
registerAction2(DecompileFunctionAction);
registerAction2(GenerateSignatureAction);
registerAction2(ReturnAction);
/**
 * Owns `delverListingFocused` at workbench scope.
 *
 * It describes a window-wide fact — some listing is live — so it must be
 * readable from wherever DOM focus happens to be. Bound inside the listing
 * widget it landed in the editor group's scoped context key service, and every
 * keybinding gated on it lost to upstream whenever focus sat outside that group:
 * Ctrl+Z ran the text editor's undo, F2 and `;` did nothing.
 */
class DelverListingActiveContribution extends Disposable {
	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		const key = DELVER_LISTING_FOCUSED.bindTo(contextKeyService);
		const sync = () => key.set(activeListing() !== undefined);
		sync();
		this._register(onDidChangeActiveListing(sync));
	}
}

registerWorkbenchContribution2(
	'delver.listingActive',
	DelverListingActiveContribution,
	WorkbenchPhase.BlockRestore,
);

registerAction2(RenameAction);
registerAction2(CommentAction);
registerAction2(TagAction);
registerAction2(UndoInterpretationAction);
registerAction2(RedoInterpretationAction);
registerAction2(RevertAuthorAction);
registerAction2(ExportInterpretationAction);
registerAction2(ImportInterpretationAction);

registerWorkbenchContribution2(
	'delver.projectAutoOpen',
	DelverProjectAutoOpenContribution,
	WorkbenchPhase.AfterRestored,
);

registerDelverSurface({
	id: DelverSurfaceId.Listing,
	title: localize2('delverListingSurface', "Listing"),
	zone: DelverZone.Primary,
	order: 10,
	ctor: new SyncDescriptor(DelverListingWidget),
	// Pseudocode rides this tab. The two were always read together — selecting
	// either showed both — so two tabs advertised a choice that did not exist.
	companions: [DelverSurfaceId.Pseudocode],
	contextKey: context => context.targetPath,
	setContext: (surface, context, token) => surface.setTarget(context.targetPath, token),
	tearOff: context => new DelverListingInput(context.targetPath),
});

/**
 * Keeps the history context keys current.
 *
 * The toolbar arrows are gated on these, so without something publishing them
 * the controls would be permanently disabled — the class of bug where a feature
 * exists and is unreachable.
 */
class DelverHistoryContextContribution extends Disposable {
	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IDelverFocusService focusService: IDelverFocusService,
	) {
		super();
		const back = DELVER_CAN_GO_BACK.bindTo(contextKeyService);
		const forward = DELVER_CAN_GO_FORWARD.bindTo(contextKeyService);
		const update = () => {
			back.set(focusService.canGoBack);
			forward.set(focusService.canGoForward);
		};
		update();
		this._register(focusService.onDidChangeFocus(update));
	}
}

registerWorkbenchContribution2(
	'delver.historyContext',
	DelverHistoryContextContribution,
	WorkbenchPhase.BlockRestore,
);
