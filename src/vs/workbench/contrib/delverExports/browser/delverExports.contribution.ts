/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IExportWire } from '../../../../platform/delver/common/protocol.generated.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import {
	Extensions as ViewExtensions,
	ITreeItem,
	ITreeViewDataProvider,
	ITreeViewDescriptor,
	IViewsRegistry,
	TreeItemCollapsibleState,
} from '../../../common/views.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { registerInterpretationViewActions } from '../../../services/delver/browser/delverInterpretationEditing.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';

export const DELVER_EXPORTS_VIEW_ID = 'delver.view.exports';

const DELVER_EXPORTS_OPEN_COMMAND = 'delver.exports.goTo';

const viewName = localize2('delverExports', "Exports");

/** Identifies this view on the focus bus. */
const FOCUS_ORIGIN = 'delver.view.exports';

class DelverExportsTreeDataProvider implements ITreeViewDataProvider {
	private exports: readonly IExportWire[] | undefined;

	setExports(exports: readonly IExportWire[] | undefined): void {
		this.exports = exports;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (element || !this.exports) {
			return [];
		}
		return this.exports.map(exportItem);
	}
}

function exportItem(symbol: IExportWire, index: number): ITreeItem {
	// Exports by ordinal carry no name; showing the ordinal is the honest answer.
	const label = symbol.name
		?? localize('delverExportOrdinal', "Ordinal {0}", symbol.ordinal);

	// A forwarded export has no address in this image at all — it resolves into
	// another module. Saying where it goes is the only useful thing to show, and
	// it must not look navigable, because there is nothing here to navigate to.
	const forwarded = symbol.forwarded_to !== undefined;

	return {
		handle: `delver.export.${index}.${symbol.rva ?? 'forwarded'}`,
		label: { label },
		contextValue: forwarded ? undefined : 'delver-export',
		description: forwarded
			? localize('delverExportForwarded', "→ {0}", symbol.forwarded_to!)
			: symbol.rva,
		themeIcon: ThemeIcon.fromId(forwarded ? Codicon.arrowRight.id : Codicon.symbolFunction.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: forwarded || symbol.rva === undefined ? undefined : {
			id: DELVER_EXPORTS_OPEN_COMMAND,
			title: localize('delverExportGoTo', "Go to Export"),
			arguments: [symbol.rva],
		},
	};
}

class DelverExportsViewContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
	) {
		super();
		const treeView = this._register(instantiationService.createInstance(TreeView, DELVER_EXPORTS_VIEW_ID, viewName.value));
		const dataProvider = new DelverExportsTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_EXPORTS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			// Most targets are executables with nothing to export.
			collapsed: true,
			order: 40,
		};
		this._register(registerDelverTreeSurface(DelverSurfaceId.Exports, DelverZone.Primary, viewDescriptor));

		this._register(Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_EXPORTS_VIEW_ID,
			{
				content: localize(
					'delverExportsWelcome',
					"No target open.\n[Open Target](command:delver.target.open)",
				),
				when: DELVER_TARGET_OPEN.toNegated(),
			},
		));

		// An executable exporting nothing is the normal case and a real answer.
		// Reporting it as "no target open" told the user the tool had lost the
		// file they were looking at.
		this._register(Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_EXPORTS_VIEW_ID,
			{
				content: localize('delverExportsEmpty', "This image exports nothing."),
				when: DELVER_TARGET_OPEN,
			},
		));

		/** Guards against a slow lookup overwriting a newer session's answer. */
		let generation = 0;

		const update = async () => {
			const session = sessionService.activeSession;
			const token = ++generation;

			if (!session) {
				treeView.message = undefined;
				dataProvider.setExports(undefined);
			} else {
				try {
					const { exports } = await sessionService.exports();
					if (token !== generation) {
						return;
					}
					// An executable with no export table is the normal case, and an
					// empty pane is indistinguishable from one that failed to load.
					// Saying so is a real answer about this image (`principles.md` §1).
					treeView.message = exports.length === 0
						? localize('delverExportsEmpty', "This image exports nothing.")
						: undefined;
					dataProvider.setExports(exports);
				} catch (error) {
					if (token !== generation) {
						return;
					}
					// This runs on a session change: the symbols on screen belong to
					// the previous target, and each one navigates to its RVA in the
					// new one. Falling back to the "exports nothing" welcome would be
					// no better — that is a real answer about this image, and this is
					// not an answer at all.
					dataProvider.setExports(undefined);
					treeView.message = localize(
						'delverExportsFailed',
						"Could not load the exports: {0}",
						toErrorMessage(error),
					);
					onUnexpectedError(error);
				}
			}
			treeView.refresh().catch(onUnexpectedError);
		};

		this._register(sessionService.onDidChangeActiveSession(() => update()));

		if (sessionService.activeSession) {
			update();
		}
	}
}

registerWorkbenchContribution2(
	'delver.exportsView',
	DelverExportsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_EXPORTS_OPEN_COMMAND, (accessor: ServicesAccessor, rva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
});

registerInterpretationViewActions({
	commandPrefix: 'delver.exports',
	viewId: DELVER_EXPORTS_VIEW_ID,
	contextValue: 'delver-export',
});
