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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';

export const DELVER_OVERVIEW_VIEW_ID = 'delver.view.overview';

const viewName = localize2('delverOverview', "Overview");

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

		const rows: [string, string, ThemeIcon][] = [
			[localize('delverOverviewFile', "File"), basename(this.targetPath ?? ''), ThemeIcon.fromId(Codicon.fileBinary.id)],
			[localize('delverOverviewArch', "Architecture"), this.info.arch, ThemeIcon.fromId(Codicon.chip.id)],
			// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
			// arrived; re-formatting through a number would truncate above 2^53.
			[localize('delverOverviewEntry', "Entry point"), this.info.entry, ThemeIcon.fromId(Codicon.debugStart.id)],
			[localize('delverOverviewBase', "Image base"), this.info.image_base, ThemeIcon.fromId(Codicon.milestone.id)],
			[localize('delverOverviewInstructions', "Instructions"), count(this.image.instruction_count), ThemeIcon.fromId(Codicon.listOrdered.id)],
			[localize('delverOverviewFunctions', "Functions"), count(this.image.function_count), ThemeIcon.fromId(Codicon.symbolFunction.id)],
			[localize('delverOverviewXrefs', "References"), count(this.image.xref_count), ThemeIcon.fromId(Codicon.references.id)],
			[localize('delverOverviewStrings', "Strings"), count(this.image.string_count), ThemeIcon.fromId(Codicon.symbolString.id)],
		];

		return rows.map(([label, value, icon], index) => ({
			handle: `delver.overview.${index}`,
			label: { label },
			description: value,
			themeIcon: icon,
			collapsibleState: TreeItemCollapsibleState.None,
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
				when: 'default',
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
