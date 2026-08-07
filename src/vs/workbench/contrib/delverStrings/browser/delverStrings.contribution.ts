/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IStringsResult, IStringWire, StringEncodingWire } from '../../../../platform/delver/common/protocol.generated.js';
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
import { registerDelverView } from '../../../services/delver/browser/delverViewContainer.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';

export const DELVER_STRINGS_VIEW_ID = 'delver.view.strings';

const DELVER_STRINGS_OPEN_COMMAND = 'delver.strings.goTo';

const viewName = localize2('delverStrings', "Strings");

/** Identifies this view on the focus bus. */
const FOCUS_ORIGIN = 'delver.view.strings';

/**
 * How many strings the pane will list.
 *
 * Separate from, and smaller than, the analysis cap: this one is about a tree
 * that stays responsive, not about a hostile file. Both are reported.
 */
const DISPLAY_LIMIT = 2_000;

/**
 * Strings found in the image.
 *
 * Every string here is **attacker-controlled text**. It is rendered as a tree
 * label, which is plain text — nothing interpolates it into markup, and nothing
 * should. See `Docs/architecture/security-model.md`, section 4.
 */
class DelverStringsTreeDataProvider implements ITreeViewDataProvider {
	private result: IStringsResult | undefined;

	setStrings(result: IStringsResult | undefined): void {
		this.result = result;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		const result = this.result;
		if (element || !result) {
			return [];
		}

		const items = result.strings.slice(0, DISPLAY_LIMIT).map(stringItem);

		// Say so when the list is partial, and say which limit caused it. A
		// strings pane silently missing entries is worse than one that admits
		// it, because a search that finds nothing then means nothing.
		const hiddenByDisplay = Math.max(0, result.strings.length - DISPLAY_LIMIT);
		if (result.truncated) {
			items.push(note(localize(
				'delverStringsTruncatedByScan',
				"Scan limit reached — this image contains more strings than are listed.",
			)));
		} else if (hiddenByDisplay > 0) {
			items.push(note(localize(
				'delverStringsTruncatedByView',
				"{0} more not shown.",
				hiddenByDisplay,
			)));
		}

		return items;
	}
}

function stringItem(found: IStringWire, index: number): ITreeItem {
	return {
		handle: `delver.string.${index}`,
		label: { label: found.text },
		// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
		// arrived.
		description: found.encoding === StringEncodingWire.Utf16Le
			? localize('delverStringUtf16', "{0} · UTF-16", found.rva)
			: found.rva,
		themeIcon: ThemeIcon.fromId(Codicon.symbolString.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_STRINGS_OPEN_COMMAND,
			title: localize('delverStringGoTo', "Go to String"),
			arguments: [found.rva],
		},
	};
}

function note(label: string): ITreeItem {
	return {
		handle: 'delver.strings.note',
		label: { label },
		themeIcon: ThemeIcon.fromId(Codicon.info.id),
		collapsibleState: TreeItemCollapsibleState.None,
	};
}

class DelverStringsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverAnalysisService analysisService: IDelverAnalysisService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_STRINGS_VIEW_ID, viewName.value);
		const dataProvider = new DelverStringsTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_STRINGS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			// Long, and consulted on demand rather than read on open.
			collapsed: true,
			order: 50,
		};
		registerDelverView(viewDescriptor);

		Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(
			DELVER_STRINGS_VIEW_ID,
			{
				content: localize(
					'delverStringsWelcome',
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
				dataProvider.setStrings(undefined);
			} else {
				try {
					const result = await analysisService.strings(session.sessionId);
					if (token !== generation) {
						return;
					}
					dataProvider.setStrings(result);
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
	'delver.stringsView',
	DelverStringsViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_STRINGS_OPEN_COMMAND, (accessor: ServicesAccessor, rva: string) => {
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
});
