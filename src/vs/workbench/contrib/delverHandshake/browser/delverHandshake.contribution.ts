/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ITreeViewDescriptor } from '../../../common/views.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { IDelverDecompilerService } from '../../../services/delver/common/delverDecompilerService.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { handshake } from '../../../services/delver/common/delverFunctionHandshake.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverWorkspaceService } from '../../../services/delver/common/delverWorkspaceService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	DELVER_HANDSHAKE_OPEN_COMMAND,
	DELVER_HANDSHAKE_VIEW_ID,
	DelverHandshakeTreeDataProvider,
} from './delverHandshakeView.js';

// One word, like every other navigator segment. "Backend Comparison" truncates
// to "Backer" in the segment strip, which reads as a different word entirely.
const viewName = localize2('delverHandshake', "Comparison");

/** Identifies this view on the focus bus. */
const FOCUS_ORIGIN = 'delver.view.handshake';

export const DELVER_HANDSHAKE_RUN_COMMAND = 'delver.handshake.run';

/**
 * Delver's recovered functions against the decompiler backend's (ADR 0017).
 *
 * Runs only when asked. The comparison opens the sample in the backend, which
 * can take a while on a large image, and a pane that did that on every session
 * change would make attaching a target unpredictably slow.
 */
class DelverHandshakeViewContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverDecompilerService decompilerService: IDelverDecompilerService,
	) {
		super();
		const treeView = this._register(instantiationService.createInstance(TreeView, DELVER_HANDSHAKE_VIEW_ID, viewName.value));
		const dataProvider = new DelverHandshakeTreeDataProvider();
		treeView.dataProvider = dataProvider;

		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_HANDSHAKE_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 60,
		};
		this._register(registerDelverTreeSurface(DelverSurfaceId.Handshake, DelverZone.Navigator, viewDescriptor));

		/** Guards against a slow comparison landing after the session changed. */
		let generation = 0;

		// The pane is empty until asked, so it has to say why rather than look
		// like a comparison that found nothing.
		const idleMessage = localize('delverHandshakeIdle', "No comparison run yet. Use the compare action in this view's title bar.");
		treeView.message = idleMessage;

		const clear = () => {
			generation++;
			dataProvider.setResult(undefined);
			treeView.message = idleMessage;
			treeView.refresh().catch(onUnexpectedError);
		};
		// Every row is an RVA in the previous image. Keeping them would offer to
		// navigate to addresses that mean something else now.
		this._register(sessionService.onDidChangeActiveSession(clear));
		this._register(sessionService.onDidRederiveFacts(clear));

		this._register(CommandsRegistry.registerCommand(DELVER_HANDSHAKE_RUN_COMMAND, async () => {
			const session = sessionService.activeSession;
			if (!session) {
				return;
			}
			const token = ++generation;
			treeView.message = localize('delverHandshakeRunning', "Comparing…");
			treeView.refresh().catch(onUnexpectedError);
			try {
				const bound = await sessionService.functions();
				// A truncated Delver list does not omit disagreements, it invents
				// them: every backend function missing from it reads as one Delver
				// never found. Refused rather than shown with a caveat.
				if (bound.list_truncated) {
					throw new Error(localize(
						'delverHandshakeTruncated',
						"This image has more functions than one analysis response carries, so the two sets cannot be compared without inventing disagreements.",
					));
				}
				const backend = await decompilerService.listBackendFunctions({
					contentHash: session.contentHash,
					sessionId: session.sessionId,
					targetPath: session.targetPath,
				});
				if (token !== generation) {
					return;
				}
				if (!backend) {
					throw new Error(localize(
						'delverHandshakeNoBackend',
						"The configured decompiler backend cannot list the functions it recovered, so there is nothing to compare against.",
					));
				}
				let complete = backend;
				if (!complete.analysisComplete) {
					// The backend imports without auto-analysis, so its first
					// answer is a fraction of its eventual one. Finish the work
					// rather than refuse: refusing is honest but leaves the
					// comparison permanently unavailable, and the cost is the
					// analyst's to accept once per image.
					treeView.message = localize('delverHandshakeAnalyzing', "Waiting for the decompiler backend to finish analyzing…");
					treeView.refresh().catch(onUnexpectedError);
					const analyzed = await decompilerService.analyzeBackendTarget({
						contentHash: session.contentHash,
						sessionId: session.sessionId,
						targetPath: session.targetPath,
					}, CancellationToken.None);
					if (token !== generation) {
						return;
					}
					if (!analyzed?.analysisComplete) {
						throw new Error(localize(
							'delverHandshakeIncomplete',
							"The decompiler backend has not finished analyzing this image. Its function set is still incomplete, and comparing it now would report the shortfall as disagreement.",
						));
					}
					const refreshed = await decompilerService.listBackendFunctions({
						contentHash: session.contentHash,
						sessionId: session.sessionId,
						targetPath: session.targetPath,
					});
					if (token !== generation) {
						return;
					}
					if (!refreshed?.analysisComplete) {
						throw new Error(localize(
							'delverHandshakeStillIncomplete',
							"The decompiler backend still reports an incomplete function set after analyzing, so there is nothing trustworthy to compare.",
						));
					}
					complete = refreshed;
				}
				dataProvider.setResult(handshake(bound.functions, complete));
				treeView.message = undefined;
			} catch (error) {
				if (token !== generation) {
					return;
				}
				dataProvider.setResult(undefined);
				treeView.message = localize('delverHandshakeFailed', "Could not compare: {0}", toErrorMessage(error));
			}
			treeView.refresh().catch(onUnexpectedError);
		}));
	}
}

registerWorkbenchContribution2(
	'delver.handshakeView',
	DelverHandshakeViewContribution,
	WorkbenchPhase.AfterRestored,
);

CommandsRegistry.registerCommand(DELVER_HANDSHAKE_OPEN_COMMAND, async (accessor: ServicesAccessor, rva: string) => {
	const session = accessor.get(IDelverSessionService).activeSession;
	if (!session) {
		return;
	}
	accessor.get(IDelverFocusService).setFocus(
		{ location: { space: 'Image', address: BigInt(rva) } },
		FOCUS_ORIGIN,
		FocusReason.User,
	);
	await accessor.get(IEditorService).openEditor(
		new DelverWorkspaceInput(session.projectPath ?? session.targetPath),
		{ pinned: true },
	);
	accessor.get(IDelverWorkspaceService).showSurface(DelverSurfaceId.Listing);
});

class RunHandshakeAction extends Action2 {
	constructor() {
		super({
			id: 'delver.handshake.runFromPalette',
			title: localize2('delverHandshakeRun', "Compare Functions Against Decompiler Backend"),
			category: localize2('delverCategory', "Delver"),
			icon: Codicon.gitCompare,
			f1: true,
			precondition: DELVER_TARGET_OPEN,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', DELVER_HANDSHAKE_VIEW_ID),
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(DELVER_HANDSHAKE_RUN_COMMAND);
	}
}

/**
 * Finishes the backend's analysis without asking for a comparison.
 *
 * Measured at 22s for a 764 KB image and 30s for `ntdll.dll`, once per content
 * hash because the analyzed program is cached. Worth having on its own: an
 * analyst who sees `UNDEF_` placeholders in pseudocode is looking at calls whose
 * targets the backend has not recovered yet, and this is what fixes that.
 */
class AnalyzeBackendTargetAction extends Action2 {
	constructor() {
		super({
			id: 'delver.handshake.analyzeBackend',
			title: localize2('delverAnalyzeBackend', "Analyze Target in Decompiler Backend"),
			category: localize2('delverCategory', "Delver"),
			f1: true,
			precondition: DELVER_TARGET_OPEN,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const session = accessor.get(IDelverSessionService).activeSession;
		if (!session) {
			return;
		}
		const decompilerService = accessor.get(IDelverDecompilerService);
		const notificationService = accessor.get(INotificationService);
		const request = {
			contentHash: session.contentHash,
			sessionId: session.sessionId,
			targetPath: session.targetPath,
		};
		const cancellation = new CancellationTokenSource();
		try {
			await accessor.get(IProgressService).withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('delverAnalyzeBackendProgress', "Analyzing in the decompiler backend…"),
					cancellable: true,
				},
				async () => {
					const result = await decompilerService.analyzeBackendTarget(request, cancellation.token);
					if (!result) {
						notificationService.warn(localize('delverAnalyzeBackendUnsupported', "The configured decompiler backend cannot be asked to analyze a target."));
						return;
					}
					notificationService.info(result.alreadyAnalyzed
						? localize('delverAnalyzeBackendAlready', "The decompiler backend had already analyzed this image.")
						: localize('delverAnalyzeBackendDone', "The decompiler backend finished analyzing this image."));
				},
				() => cancellation.cancel(),
			);
		} finally {
			cancellation.dispose();
		}
	}
}

registerAction2(RunHandshakeAction);
registerAction2(AnalyzeBackendTargetAction);
