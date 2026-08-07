/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import {
	IGetImageInfoResult,
	IOpenImageResult,
} from '../../../../platform/delver/common/protocol.generated.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
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
import { registerDelverView } from '../../../services/delver/browser/delverViewContainer.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

export const DELVER_OVERVIEW_VIEW_ID = 'delver.view.overview';

const DELVER_OVERVIEW_GO_TO_COMMAND = 'delver.overview.goTo';
const DELVER_OVERVIEW_REVEAL_COMMAND = 'delver.overview.revealView';

const viewName = localize2('delverOverview', "Overview");

interface IOverviewRow {
	readonly label: string;
	readonly value: string;
	readonly icon: string;
	readonly command?: { readonly id: string; readonly args: unknown[] };
}

/**
 * What the open image is, in one glance.
 *
 * Small on purpose. It exists so that opening a target answers "did anything
 * load, and what is it" before any other pane has to be consulted.
 */
class DelverOverviewTreeDataProvider implements ITreeViewDataProvider {
	private info: IGetImageInfoResult | undefined;
	private image: IOpenImageResult | undefined;
	private targetPath: string | undefined;

	setContent(targetPath: string | undefined, image: IOpenImageResult | undefined, info: IGetImageInfoResult | undefined): void {
		this.targetPath = targetPath;
		this.image = image;
		this.info = info;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (element || !this.image || !this.info) {
			return [];
		}

		// Every row that can lead somewhere does. Overview is the first thing you
		// read after opening a target, so it works better as a table of contents
		// than as a readout you look at once and never touch again.
		const rows: IOverviewRow[] = [
			{ label: localize('delverOverviewFile', "File"), value: basename(this.targetPath ?? ''), icon: Codicon.fileBinary.id },
			{ label: localize('delverOverviewArch', "Architecture"), value: this.info.arch, icon: Codicon.chip.id },
			// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
			// arrived; re-formatting through a number would truncate above 2^53.
			{
				label: localize('delverOverviewEntry', "Entry point"),
				value: this.info.entry,
				icon: Codicon.debugStart.id,
				command: { id: DELVER_OVERVIEW_GO_TO_COMMAND, args: [this.info.entry] },
			},
			{ label: localize('delverOverviewBase', "Image base"), value: this.info.image_base, icon: Codicon.milestone.id },
			{
				label: localize('delverOverviewInstructions', "Instructions"),
				value: count(this.image.instruction_count),
				icon: Codicon.listOrdered.id,
				command: { id: 'delver.listing.openCurrent', args: [] },
			},
			{
				label: localize('delverOverviewFunctions', "Functions"),
				value: count(this.image.function_count),
				icon: Codicon.symbolFunction.id,
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: ['delver.view.functions'] },
			},
			{
				label: localize('delverOverviewXrefs', "References"),
				value: count(this.image.xref_count),
				icon: Codicon.references.id,
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: ['delver.view.xrefs'] },
			},
			{
				label: localize('delverOverviewStrings', "Strings"),
				value: count(this.image.string_count),
				icon: Codicon.symbolString.id,
				command: { id: 'delver.strings.open', args: [] },
			},
		];

		return rows.map((row, index) => ({
			handle: `delver.overview.${index}`,
			label: { label: row.label },
			description: row.value,
			themeIcon: ThemeIcon.fromId(row.icon),
			collapsibleState: TreeItemCollapsibleState.None,
			command: row.command === undefined ? undefined : {
				id: row.command.id,
				title: row.label,
				arguments: row.command.args,
			},
		}));
	}
}

function count(value: number): string {
	return value.toLocaleString();
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}

class DelverOverviewViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
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
		registerDelverView(viewDescriptor);

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
				dataProvider.setContent(undefined, undefined, undefined);
			} else {
				try {
					const info = await analysisService.imageInfo(session.sessionId);
					if (token !== generation) {
						return;
					}
					dataProvider.setContent(session.targetPath, session.image, info);
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
