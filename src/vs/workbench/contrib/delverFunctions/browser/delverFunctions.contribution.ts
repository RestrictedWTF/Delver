/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry, TreeViewItemHandleArg } from '../../../common/views.js';
import { registerDelverView } from '../../../services/delver/browser/delverViewContainer.js';
import { editInterpretationAt } from '../../../services/delver/browser/delverInterpretationEditing.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
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
class DelverFunctionsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
		@IDelverInterpretationService interpretationService: IDelverInterpretationService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_FUNCTIONS_VIEW_ID, viewName.value);
		const dataProvider = new DelverFunctionsTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_FUNCTIONS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 20,
		};
		registerDelverView(viewDescriptor);

		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_FUNCTIONS_VIEW_ID,
			{
				content: localize(
					'delverFunctionsWelcome',
					"No target open.\n[Open Target](command:delver.target.open)",
				),
				when: DELVER_TARGET_OPEN.toNegated(),
			},
		);

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;
		let lastFunctions: readonly IFunctionWire[] = [];

		const applyNames = (functions: readonly IFunctionWire[]) => {
			lastFunctions = functions;
			const session = sessionService.activeSession;
			if (!session) {
				dataProvider.setNames(new Map());
				return;
			}
			const names = new Map<string, string>();
			for (const fn of functions) {
				const name = interpretationService.nameAt({
					kind: 'image',
					contentHash: session.contentHash,
					rva: BigInt(fn.rva),
				});
				if (name !== undefined) {
					names.set(fn.rva, name);
				}
			}
			dataProvider.setNames(names);
		};

		// Renaming anything re-labels this pane immediately. The log is the
		// truth; this view is one of its caches.
		interpretationService.onDidChange(() => {
			applyNames(lastFunctions);
			treeView.refresh().catch(onUnexpectedError);
		});

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				dataProvider.setFunctions(undefined);
			} else {
				try {
					const { functions } = await analysisService.functions(session.sessionId);
					if (token !== generation) {
						return;
					}
					dataProvider.setFunctions(functions);
					applyNames(functions);
				} catch (error) {
					if (token !== generation) {
						return;
					}
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
	'delver.functionsView',
	DelverFunctionsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_FUNCTIONS_OPEN_COMMAND, (accessor: ServicesAccessor, rva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
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

registerAction2(RenameFunctionAction);
registerAction2(CommentFunctionAction);
