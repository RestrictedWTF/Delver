/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry } from '../../../common/views.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { IDelverProjectService } from '../../../services/delver/common/delverProjectService.js';
import { DELVER_TARGET_ATTACHED, DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { CopyIdaPythonMatcherAction, CopySignaturePatternAction, DeleteSavedSignatureAction, ExportIdaPythonMatchersAction, GoToSignatureMatchAction, RegenerateRevisionSignatureAction, RenameSavedSignatureAction, ScanEarlierSignaturesAction, SearchBytePatternAction } from './delverSignaturesActions.js';
import { DELVER_SIGNATURES_VIEW_ID, IDelverSignaturesStateService } from './delverSignaturesState.js';
import { DelverSignaturesTreeDataProvider } from './delverSignaturesView.js';

const viewName = localize2('delverSignatures', "Signatures");

/** Registers the signature search and durable evidence view. */
class DelverSignaturesViewContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverProjectService projectService: IDelverProjectService,
		@IDelverSignaturesStateService stateService: IDelverSignaturesStateService,
	) {
		super();
		const treeView = instantiationService.createInstance(TreeView, DELVER_SIGNATURES_VIEW_ID, viewName.value);
		const dataProvider = new DelverSignaturesTreeDataProvider();
		treeView.dataProvider = dataProvider;
		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_SIGNATURES_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 75,
		};
		registerDelverTreeSurface(DelverSurfaceId.Signatures, DelverZone.Inspector, viewDescriptor);

		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		viewsRegistry.registerViewWelcomeContent(DELVER_SIGNATURES_VIEW_ID, {
			content: localize('delverSignaturesNoTarget', "Open a target or project to inspect signatures.\n[Open Target](command:delver.target.open) [Open Project](command:delver.project.open)"),
			when: DELVER_TARGET_OPEN.toNegated(),
		});
		viewsRegistry.registerViewWelcomeContent(DELVER_SIGNATURES_VIEW_ID, {
			content: localize('delverSignaturesAttachedWelcome', "Search for an IDA-style byte pattern, scan signatures from earlier project revisions, or select a listing instruction to generate one.\n[Search Byte Pattern...](command:delver.signatures.search) [Scan Earlier Signatures](command:delver.signatures.scanRevisions)"),
			when: DELVER_TARGET_ATTACHED,
		});
		viewsRegistry.registerViewWelcomeContent(DELVER_SIGNATURES_VIEW_ID, {
			content: localize('delverSignaturesOfflineWelcome', "No signatures are saved for this project revision. Attach its sample to search or generate signatures.\n[Locate Target...](command:delver.project.locateTarget)"),
			when: ContextKeyExpr.and(DELVER_TARGET_OPEN, DELVER_TARGET_ATTACHED.toNegated()),
		});

		const update = () => {
			const session = sessionService.activeSession;
			dataProvider.setSearch(stateService.search);
			dataProvider.setRevisionScan(stateService.revisionScan);
			dataProvider.setSignatures(session ? projectService.signaturesFor(session.contentHash) : []);
			treeView.refresh().catch(onUnexpectedError);
		};
		this._register(stateService.onDidChange(update));
		this._register(sessionService.onDidChangeActiveSession(() => {
			stateService.clear();
			update();
		}));
		this._register(projectService.onDidChangeSignatures(event => {
			if (sessionService.activeSession?.contentHash === event.contentHash) {
				update();
			}
		}));
		update();
	}
}

registerWorkbenchContribution2('delver.signaturesView', DelverSignaturesViewContribution, WorkbenchPhase.AfterRestored);
registerAction2(SearchBytePatternAction);
registerAction2(GoToSignatureMatchAction);
registerAction2(CopySignaturePatternAction);
registerAction2(CopyIdaPythonMatcherAction);
registerAction2(ExportIdaPythonMatchersAction);
registerAction2(ScanEarlierSignaturesAction);
registerAction2(RegenerateRevisionSignatureAction);
registerAction2(RenameSavedSignatureAction);
registerAction2(DeleteSavedSignatureAction);
