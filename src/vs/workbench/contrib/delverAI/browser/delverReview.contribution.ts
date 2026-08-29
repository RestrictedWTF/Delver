/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { DelverFindingOutcome } from '../../../../platform/delver/common/findings.js';
import { EditStatus } from '../../../../platform/delver/common/interpretation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TreeView, TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, ITreeViewDescriptor, IViewsRegistry, TreeViewItemHandleArg } from '../../../common/views.js';
import { Emitter } from '../../../../base/common/event.js';
import { DelverSurfaceId, DelverZone } from '../../../services/delver/browser/delverSurface.js';
import { registerDelverTreeSurface } from '../../../services/delver/browser/delverTreeSurface.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { IDelverProjectService } from '../../../services/delver/common/delverProjectService.js';
import { DELVER_TARGET_OPEN, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import {
	DELVER_REVIEW_FINDING_CONTEXT,
	DELVER_REVIEW_FINDINGS_CONTEXT,
	DELVER_REVIEW_FINDINGS_HANDLE,
	DELVER_REVIEW_GO_TO_COMMAND,
	DELVER_REVIEW_OPEN_TOOL_CALL_COMMAND,
	DELVER_REVIEW_PROPOSAL_CONTEXT,
	DELVER_REVIEW_PROPOSALS_CONTEXT,
	DELVER_REVIEW_PROPOSALS_HANDLE,
	DELVER_REVIEW_VIEW_ID,
	DelverReviewTreeDataProvider,
	findingIdFromHandle,
	proposalSequenceFromHandle,
} from './delverReviewView.js';
import { DELVER_TOOL_CALL_SCHEME, DelverToolCallContentProvider, delverToolCallResource } from './delverToolCallContentProvider.js';

const viewName = localize2('delverReview', "Review");
const FOCUS_ORIGIN = 'delver.view.review';

export class DelverReviewViewContribution extends Disposable {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IDelverSessionService sessionService: IDelverSessionService,
		@IDelverInterpretationService interpretationService: IDelverInterpretationService,
		@IDelverProjectService projectService: IDelverProjectService,
		@ITextModelService textModelService: ITextModelService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		// A correction set applies whole or not at all, so one correction that
		// conflicts with another leaves *every* correction unapplied while this
		// very view still shows them accepted. Silence here is the worst
		// available outcome: the analyst reads uncorrected facts believing they
		// are corrected, and nothing on screen disagrees.
		this._register(sessionService.onDidRefuseCorrections(({ reason }) => notificationService.error(
			localize('delverCorrectionsRefused', "Delver could not apply the accepted corrections, so analysis still reflects the previous ones. {0}", reason),
		)));
		const toolCallContentProvider = instantiationService.createInstance(DelverToolCallContentProvider);
		this._register(textModelService.registerTextModelContentProvider(DELVER_TOOL_CALL_SCHEME, toolCallContentProvider));
		const treeView = this._register(instantiationService.createInstance(TreeView, DELVER_REVIEW_VIEW_ID, viewName.value));
		const dataProvider = new DelverReviewTreeDataProvider();
		treeView.dataProvider = dataProvider;
		const viewDescriptor: ITreeViewDescriptor = {
			id: DELVER_REVIEW_VIEW_ID,
			name: viewName,
			ctorDescriptor: new SyncDescriptor(TreeViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			treeView,
			collapsed: false,
			order: 80,
		};
		const badge = this._register(new Emitter<number | undefined>());
		this._register(registerDelverTreeSurface(DelverSurfaceId.Review, DelverZone.Inspector, viewDescriptor, badge.event));

		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		this._register(viewsRegistry.registerViewWelcomeContent(DELVER_REVIEW_VIEW_ID, {
			content: localize('delverReviewNoTarget', "Open a target or project to review model-authored work.\n[Open Target](command:delver.target.open)"),
			when: DELVER_TARGET_OPEN.toNegated(),
		}));
		this._register(viewsRegistry.registerViewWelcomeContent(DELVER_REVIEW_VIEW_ID, {
			content: localize('delverReviewEmpty', "No interpretation proposals or findings are waiting for review."),
			when: DELVER_TARGET_OPEN,
		}));

		const update = () => {
			const session = sessionService.activeSession;
			const proposals = session ? interpretationService.pendingProposals(session.contentHash) : [];
			const findings = session ? projectService.pendingFindings(session.contentHash) : [];
			dataProvider.setPending(
				proposals,
				findings,
				session ? projectService.toolCallsFor(session.contentHash) : [],
			);
			badge.fire(proposals.length + findings.length || undefined);
			treeView.refresh().catch(onUnexpectedError);
		};
		this._register(sessionService.onDidChangeActiveSession(update));
		this._register(interpretationService.onDidChange(event => {
			if (event.edit.anchor.contentHash === sessionService.activeSession?.contentHash) {
				update();
			}
		}));
		this._register(projectService.onDidChangeFindings(event => {
			if (event.contentHash === sessionService.activeSession?.contentHash) {
				update();
			}
		}));
		update();
	}
}

registerWorkbenchContribution2('delver.reviewView', DelverReviewViewContribution, WorkbenchPhase.AfterRestored);

CommandsRegistry.registerCommand(DELVER_REVIEW_GO_TO_COMMAND, (accessor: ServicesAccessor, start: string, end?: string) => {
	accessor.get(IDelverFocusService).setFocus({
		location: { space: 'Image', address: BigInt(start) },
		selections: end === undefined ? undefined : [{ start: BigInt(start), end: BigInt(end) }],
	}, FOCUS_ORIGIN, FocusReason.User);
});

CommandsRegistry.registerCommand(DELVER_REVIEW_OPEN_TOOL_CALL_COMMAND, async (accessor: ServicesAccessor, contentHash: string, callId: string) => {
	// Service accessors are invocation-scoped. Resolve every dependency before
	// the first await so opening the editor cannot outlive the accessor.
	const projectService = accessor.get(IDelverProjectService);
	const editorService = accessor.get(IEditorService);
	const call = projectService.toolCall(contentHash, callId);
	if (!call) {
		return;
	}
	await editorService.openEditor({
		resource: delverToolCallResource(call),
		label: localize('delverReviewToolCallEditorLabel', "Tool Call: {0}", call.capability),
		description: call.callId,
		options: { pinned: true },
	});
});

const reviewItemWhen = ContextKeyExpr.and(
	ContextKeyExpr.equals('view', DELVER_REVIEW_VIEW_ID),
	ContextKeyExpr.or(
		ContextKeyExpr.equals('viewItem', DELVER_REVIEW_PROPOSAL_CONTEXT),
		ContextKeyExpr.equals('viewItem', DELVER_REVIEW_FINDING_CONTEXT),
	),
);

registerAction2(class AcceptDelverReviewItemAction extends Action2 {
	constructor() {
		super({
			id: 'delver.review.accept',
			title: localize('delverReviewAccept', "Accept"),
			icon: Codicon.check,
			menu: { id: MenuId.ViewItemContext, when: reviewItemWhen, group: 'inline', order: 1 },
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		return decideReviewItem(accessor, handle.$treeItemHandle, 'accepted');
	}
});

registerAction2(class RejectDelverReviewItemAction extends Action2 {
	constructor() {
		super({
			id: 'delver.review.reject',
			title: localize('delverReviewReject', "Reject"),
			icon: Codicon.close,
			menu: { id: MenuId.ViewItemContext, when: reviewItemWhen, group: 'inline', order: 2 },
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		return decideReviewItem(accessor, handle.$treeItemHandle, 'rejected');
	}
});

const reviewGroupWhen = ContextKeyExpr.and(
	ContextKeyExpr.equals('view', DELVER_REVIEW_VIEW_ID),
	ContextKeyExpr.or(
		ContextKeyExpr.equals('viewItem', DELVER_REVIEW_PROPOSALS_CONTEXT),
		ContextKeyExpr.equals('viewItem', DELVER_REVIEW_FINDINGS_CONTEXT),
	),
);

registerAction2(class AcceptAllDelverReviewItemsAction extends Action2 {
	constructor() {
		super({
			id: 'delver.review.acceptAll',
			title: localize('delverReviewAcceptAll', "Accept All"),
			icon: Codicon.check,
			menu: { id: MenuId.ViewItemContext, when: reviewGroupWhen, group: 'inline', order: 1 },
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		return decideReviewGroup(accessor, handle.$treeItemHandle, 'accepted');
	}
});

registerAction2(class RejectAllDelverReviewItemsAction extends Action2 {
	constructor() {
		super({
			id: 'delver.review.rejectAll',
			title: localize('delverReviewRejectAll', "Reject All"),
			icon: Codicon.close,
			menu: { id: MenuId.ViewItemContext, when: reviewGroupWhen, group: 'inline', order: 2 },
		});
	}

	run(accessor: ServicesAccessor, handle: TreeViewItemHandleArg): Promise<void> {
		return decideReviewGroup(accessor, handle.$treeItemHandle, 'rejected');
	}
});

/**
 * Resolves every service a review decision needs.
 *
 * Service accessors are invocation-scoped: they stop resolving once the
 * synchronous invocation returns, which is long before an awaited decision
 * settles. Resolving up front — the notification service above all — keeps the
 * failure path able to report itself instead of throwing an illegal-state error
 * that leaves the analyst with no feedback at all.
 */
function reviewServices(accessor: ServicesAccessor) {
	return {
		sessionService: accessor.get(IDelverSessionService),
		interpretationService: accessor.get(IDelverInterpretationService),
		projectService: accessor.get(IDelverProjectService),
		notificationService: accessor.get(INotificationService),
	};
}

async function decideReviewGroup(accessor: ServicesAccessor, handle: string, outcome: DelverFindingOutcome): Promise<void> {
	const { sessionService, interpretationService, projectService, notificationService } = reviewServices(accessor);
	const session = sessionService.activeSession;
	if (!session) {
		return;
	}
	try {
		if (handle === DELVER_REVIEW_PROPOSALS_HANDLE) {
			const sequences = interpretationService.pendingProposals(session.contentHash).map(proposal => proposal.seq);
			if (sequences.length === 0) {
				return;
			}
			await interpretationService.resolveProposals(
				session.contentHash,
				sequences,
				outcome === 'accepted' ? EditStatus.Accepted : EditStatus.Rejected,
			);
		} else if (handle === DELVER_REVIEW_FINDINGS_HANDLE) {
			const findingIds = projectService.pendingFindings(session.contentHash).map(finding => finding.id);
			if (findingIds.length === 0) {
				return;
			}
			await projectService.resolveFindings(session.contentHash, findingIds, outcome);
		} else {
			return;
		}
		if (!sessionService.projectPath) {
			sessionService.markProjectDirty();
		}
	} catch (error) {
		notificationService.error(error instanceof Error ? error.message : String(error));
	}
}

async function decideReviewItem(accessor: ServicesAccessor, handle: string, outcome: DelverFindingOutcome): Promise<void> {
	const { sessionService, interpretationService, projectService, notificationService } = reviewServices(accessor);
	const session = sessionService.activeSession;
	if (!session) {
		return;
	}
	try {
		const proposalSeq = proposalSequenceFromHandle(handle);
		const findingId = findingIdFromHandle(handle);
		if (proposalSeq !== undefined) {
			await interpretationService.resolveProposals(
				session.contentHash,
				[proposalSeq],
				outcome === 'accepted' ? EditStatus.Accepted : EditStatus.Rejected,
			);
		} else if (findingId !== undefined) {
			await projectService.resolveFindings(session.contentHash, [findingId], outcome);
		} else {
			return;
		}
		if (!sessionService.projectPath) {
			sessionService.markProjectDirty();
		}
	} catch (error) {
		notificationService.error(error instanceof Error ? error.message : String(error));
	}
}
