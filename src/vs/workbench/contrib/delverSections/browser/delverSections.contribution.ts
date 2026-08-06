/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewsRegistry, Extensions as ViewExtensions, ITreeViewDescriptor } from '../../../common/views.js';
import { VIEW_CONTAINER } from '../../files/browser/explorerViewlet.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IDelverTargetService } from '../../../services/delver/common/delverTargetService.js';
import { DelverSectionsTreeDataProvider, DELVER_SECTIONS_VIEW_ID } from './delverSectionsView.js';
import { IGetImageInfoResult } from '../../../../platform/delver/common/protocol.generated.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const viewName = localize2('delverSections', "Sections");

class DelverSectionsViewContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverTargetService delverTargetService: IDelverTargetService,
	) {
		const treeView = instantiationService.createInstance(TreeView, DELVER_SECTIONS_VIEW_ID, viewName.value);
		const dataProvider = instantiationService.createInstance(DelverSectionsTreeDataProvider);
		treeView.dataProvider = dataProvider;

		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_SECTIONS_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 100,
		};
		viewsRegistry.registerViews([viewDescriptor], VIEW_CONTAINER);

		delverTargetService.onDidChangeActiveTarget(async target => {
			if (!target) {
				dataProvider.setImageInfo(undefined);
			} else {
				const info = await target.getImageInfo() as IGetImageInfoResult;
				dataProvider.setImageInfo(info);
			}
			treeView.refresh().catch(() => { /* ignore */ });
		});
	}
}

registerWorkbenchContribution2(
	'delver.sectionsView',
	DelverSectionsViewContribution,
	WorkbenchPhase.AfterRestored
);

class OpenFileTargetAction extends Action2 {
	constructor() {
		super({
			id: 'delver.target.openFile',
			title: localize2('delverOpenFile', 'Open File Target'),
			category: localize2('delverCategory', 'Delver'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const delverTargetService = accessor.get(IDelverTargetService);

		const result = await fileDialogService.showOpenDialog({
			openLabel: localize('delverOpenFileLabel', 'Open'),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
		});

		if (!result || result.length === 0) {
			return;
		}

		await delverTargetService.attach({ kind: 'file', path: result[0].fsPath });
	}
}

registerAction2(OpenFileTargetAction);
