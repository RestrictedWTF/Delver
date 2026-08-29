/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditOp, isImageAnchor } from '../../../../platform/delver/common/interpretation.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry, TreeViewItemHandleArg } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { DelverFilterableTreeViewPane, registerDelverTreeFilterProvider } from '../../../services/delver/browser/delverFilterableTreeViewPane.js';
import { editInterpretationAt } from '../../../services/delver/browser/delverInterpretationEditing.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { IDelverWorkspaceService } from '../../../services/delver/common/delverWorkspaceService.js';
import {
	DELVER_FUNCTIONS_OPEN_COMMAND,
	DELVER_FUNCTIONS_VIEW_ID,
	DelverFunctionsTreeDataProvider,
	functionRvaFromHandle,
} from './delverFunctionsView.js';

const viewName = localize2('delverFunctions', "Functions");

/** Identifies this view on the focus bus. */
const FOCUS_ORIGIN = 'delver.view.functions';

/**
 * Every function the analysis found, split by how much the image vouches for it.
 */
class DelverFunctionsViewContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverInterpretationService interpretationService: IDelverInterpretationService,
	) {
		super();
		const treeView = this._register(instantiationService.createInstance(TreeView, DELVER_FUNCTIONS_VIEW_ID, viewName.value));
		const dataProvider = new DelverFunctionsTreeDataProvider();
		treeView.dataProvider = dataProvider;
		registerDelverTreeFilterProvider(treeView, dataProvider);

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_FUNCTIONS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(DelverFilterableTreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 20,
		};
		this._register(registerDelverTreeSurface(DelverSurfaceId.Functions, DelverZone.Navigator, viewDescriptor));

		this._register(Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_FUNCTIONS_VIEW_ID,
			{
				content: localize(
					'delverFunctionsWelcome',
					"No target open.\n[Open Target](command:delver.target.open)",
				),
				when: DELVER_TARGET_OPEN.toNegated(),
			},
		));

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;
		let names = new Map<string, string>();
		let wireRvaByAddress = new Map<bigint, string>();

		const applyNames = (functions: readonly IFunctionWire[]) => {
			names = new Map();
			wireRvaByAddress = new Map();
			const session = sessionService.activeSession;
			if (!session) {
				dataProvider.setNames(names);
				return;
			}
			for (const fn of functions) {
				const rva = BigInt(fn.rva);
				wireRvaByAddress.set(rva, fn.rva);
				const name = interpretationService.nameAt({
					kind: 'image',
					contentHash: session.contentHash,
					rva,
				});
				if (name !== undefined) {
					names.set(fn.rva, name);
				}
			}
			dataProvider.setNames(names);
		};

		// Renaming anything re-labels this pane immediately. The log is the
		// truth; this view is one of its caches.
		this._register(interpretationService.onDidChange(event => {
			const session = sessionService.activeSession;
			if (!session || event.edit.op !== EditOp.Rename || event.edit.anchor.contentHash !== session.contentHash
				|| !isImageAnchor(event.edit.anchor)) {
				return;
			}
			const wireRva = wireRvaByAddress.get(event.edit.anchor.rva);
			if (wireRva === undefined) {
				return;
			}
			const name = interpretationService.nameAt(event.edit.anchor);
			if (name === undefined) {
				names.delete(wireRva);
			} else {
				names.set(wireRva, name);
			}
			dataProvider.setNames(names);
			treeView.refresh().catch(onUnexpectedError);
		}));

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				treeView.message = undefined;
				dataProvider.setFunctions(undefined);
			} else {
				try {
					const { functions } = await sessionService.functions();
					if (token !== generation) {
						return;
					}
					treeView.message = undefined;
					dataProvider.setFunctions(functions);
					applyNames(functions);
				} catch (error) {
					if (token !== generation) {
						return;
					}
					// The session has already changed. Every row still listed is a
					// function of the previous target, and opening one decompiles
					// that RVA in the new one — a body attributed to the wrong
					// binary. The name cache goes with them, since it is keyed by
					// the old image's RVAs.
					dataProvider.setFunctions(undefined);
					applyNames([]);
					treeView.message = localize(
						'delverFunctionsFailed',
						"Could not load the functions: {0}",
						toErrorMessage(error),
					);
					onUnexpectedError(error);
				}
			}
			treeView.refresh().catch(onUnexpectedError);
		};

		this._register(sessionService.onDidChangeActiveSession(() => update()));
		// An accepted correction re-derives the function list itself, so this
		// pane has to ask again rather than re-label what it already holds — the
		// rename path above cannot help, because the function it names may not
		// have existed a moment ago.
		this._register(sessionService.onDidRederiveFacts(() => update()));

		// A session may already be open when this contribution constructs.
		if (sessionService.activeSession) {
			update();
		}
	}
}

registerWorkbenchContribution2(
	'delver.functionsView',
	DelverFunctionsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_FUNCTIONS_OPEN_COMMAND, async (accessor: ServicesAccessor, rva: string) => {
	const session = accessor.get(IDelverSessionService).activeSession;
	if (!session) {
		return;
	}
	const address = BigInt(rva);
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
	await accessor.get(IEditorService).openEditor(
		new DelverWorkspaceInput(session.projectPath ?? session.targetPath),
		{ pinned: true },
	);
	accessor.get(IDelverWorkspaceService).showSurface(DelverSurfaceId.Pseudocode);
});

class RenameFunctionAction extends Action2 {
	constructor() {
		super({
			id: 'delver.functions.rename',
			title: localize2('delverRenameFunction', 'Rename'),
			icon: Codicon.edit,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', DELVER_FUNCTIONS_VIEW_ID),
					ContextKeyExpr.equals('viewItem', 'delver-function'),
				),
				group: 'inline',
			},
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const rva = functionRvaFromHandle(handle.$treeItemHandle);
		if (rva !== undefined) {
			await editInterpretationAt(accessor, rva, EditOp.Rename);
		}
	}
}

class CommentFunctionAction extends Action2 {
	constructor() {
		super({
			id: 'delver.functions.comment',
			title: localize2('delverCommentFunction', 'Set Comment'),
			icon: Codicon.comment,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', DELVER_FUNCTIONS_VIEW_ID),
					ContextKeyExpr.equals('viewItem', 'delver-function'),
				),
				group: '1_interpretation',
			},
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const rva = functionRvaFromHandle(handle.$treeItemHandle);
		if (rva !== undefined) {
			await editInterpretationAt(accessor, rva, EditOp.Comment);
		}
	}
}

class TagFunctionAction extends Action2 {
	constructor() {
		super({
			id: 'delver.functions.tags',
			title: localize2('delverTagFunction', 'Set Tags'),
			icon: Codicon.tag,
			menu: {
				id: MenuId.ViewItemContext,
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('view', DELVER_FUNCTIONS_VIEW_ID),
					ContextKeyExpr.equals('viewItem', 'delver-function'),
				),
				group: '1_interpretation',
				order: 2,
			},
		});
	}

	async run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		const rva = functionRvaFromHandle(handle.$treeItemHandle);
		if (rva !== undefined) {
			await editInterpretationAt(accessor, rva, EditOp.Tags);
		}
	}
}

registerAction2(RenameFunctionAction);
registerAction2(CommentFunctionAction);
registerAction2(TagFunctionAction);
