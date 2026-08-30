/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDelverFinding } from '../../../../platform/delver/common/findings.js';
import { EditOp, IEdit } from '../../../../platform/delver/common/interpretation.js';
import { IDelverToolCallRecord } from '../../../../platform/delver/common/delverToolCall.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { DelverReviewMode } from '../../../services/delver/common/delverReviewPolicy.js';

export const DELVER_REVIEW_VIEW_ID = 'delver.view.review';
export const DELVER_REVIEW_GO_TO_COMMAND = 'delver.review.goTo';
export const DELVER_REVIEW_OPEN_TOOL_CALL_COMMAND = 'delver.review.openToolCall';
export const DELVER_REVIEW_PROPOSAL_CONTEXT = 'delver-review-proposal';
export const DELVER_REVIEW_FINDING_CONTEXT = 'delver-review-finding';
export const DELVER_REVIEW_PROPOSALS_CONTEXT = 'delver-review-proposals';
export const DELVER_REVIEW_FINDINGS_CONTEXT = 'delver-review-findings';

export const DELVER_REVIEW_PROPOSALS_HANDLE = 'delver.review.proposals';
export const DELVER_REVIEW_FINDINGS_HANDLE = 'delver.review.findings';

/** Pure tree projection for pending model-authored work. */
/**
 * What an empty review pane should say.
 *
 * Emptiness has two readings here and they are not close together: nothing was
 * proposed, or everything proposed was accepted without anyone looking. An
 * empty tree cannot tell them apart, and the second is the one worth saying —
 * it is a state the analyst chose, possibly hours ago, and then stopped seeing.
 *
 * Returns undefined when there is something to review, because a message above
 * a populated tree is just noise.
 */
export function delverReviewEmptyMessage(pending: number, mode: DelverReviewMode): string | undefined {
	if (pending > 0) {
		return undefined;
	}
	return mode === 'auto'
		? localize('delverReviewEmptyAuto', "Nothing is waiting: review mode is Automatic, so proposals and findings are accepted as they arrive. Exported reports list them as accepted automatically.")
		: localize('delverReviewEmptyManual', "Nothing is waiting for review.");
}

export class DelverReviewTreeDataProvider implements ITreeViewDataProvider {
	private proposals: readonly IEdit[] = [];
	private findings: readonly IDelverFinding[] = [];
	private toolCalls = new Map<string, IDelverToolCallRecord>();

	setPending(proposals: readonly IEdit[], findings: readonly IDelverFinding[], toolCalls: readonly IDelverToolCallRecord[] = []): void {
		this.proposals = proposals;
		this.findings = findings;
		this.toolCalls = new Map(toolCalls.map(call => [call.callId, call]));
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[]> {
		if (!element) {
			return [
				...(this.proposals.length > 0 ? [groupItem(DELVER_REVIEW_PROPOSALS_HANDLE, DELVER_REVIEW_PROPOSALS_CONTEXT, localize('delverReviewProposals', "Interpretation Proposals"), this.proposals.length)] : []),
				...(this.findings.length > 0 ? [groupItem(DELVER_REVIEW_FINDINGS_HANDLE, DELVER_REVIEW_FINDINGS_CONTEXT, localize('delverReviewFindings', "Findings"), this.findings.length)] : []),
			];
		}
		if (element.handle === DELVER_REVIEW_PROPOSALS_HANDLE) {
			return this.proposals.map(proposalItem);
		}
		if (element.handle === DELVER_REVIEW_FINDINGS_HANDLE) {
			return this.findings.map(findingItem);
		}
		const evidence = evidenceFromHandle(element.handle, this.findings);
		if (evidence) {
			return (evidence.sourceCallIds ?? []).flatMap(callId => {
				const call = this.toolCalls.get(callId);
				return call ? [toolCallItem(element.handle, call)] : [];
			});
		}
		const findingId = findingIdFromHandle(element.handle);
		const finding = findingId === undefined ? undefined : this.findings.find(candidate => candidate.id === findingId);
		return finding ? finding.evidence.map((_, index) => evidenceItem(finding, index)) : [];
	}
}

export function proposalSequenceFromHandle(handle: string): number | undefined {
	const match = /^delver\.review\.proposal\.(\d+)$/.exec(handle);
	return match ? Number(match[1]) : undefined;
}

export function findingIdFromHandle(handle: string): string | undefined {
	const match = /^delver\.review\.finding\.(.+)$/.exec(handle);
	return match?.[1];
}

function groupItem(handle: string, contextValue: string, label: string, count: number): ITreeItem {
	return {
		handle,
		label: { label },
		description: String(count),
		contextValue,
		themeIcon: ThemeIcon.fromId(Codicon.checklist.id),
		collapsibleState: TreeItemCollapsibleState.Expanded,
	};
}

function proposalItem(edit: IEdit): ITreeItem {
	// A composite has no address to show or navigate to, so it is named instead.
	// A row that said "at 0x0" would be worse than one that says nothing: the
	// reviewer would go and look there.
	const anchor = edit.anchor;
	const subject = anchor.kind === 'type' ? anchor.name : wireAddress(anchor.rva);
	return {
		handle: `delver.review.proposal.${edit.seq}`,
		label: { label: proposalLabel(edit, subject) },
		description: edit.author.id,
		tooltip: localize('delverReviewProposalTooltip', "Proposed by {0} at {1}", edit.author.id, subject),
		contextValue: DELVER_REVIEW_PROPOSAL_CONTEXT,
		themeIcon: ThemeIcon.fromId(Codicon.edit.id),
		collapsibleState: TreeItemCollapsibleState.None,
		...(anchor.kind === 'type' ? {} : { command: goToCommand(anchor.rva) }),
	};
}

function findingItem(finding: IDelverFinding): ITreeItem {
	return {
		handle: `delver.review.finding.${finding.id}`,
		label: { label: finding.title },
		description: localize('delverReviewFindingDescription', "{0} · {1}%", finding.severity, Math.round(finding.confidence * 100)),
		tooltip: finding.description,
		contextValue: DELVER_REVIEW_FINDING_CONTEXT,
		themeIcon: ThemeIcon.fromId(finding.severity === 'malicious' ? Codicon.warning.id : Codicon.inspect.id),
		collapsibleState: TreeItemCollapsibleState.Expanded,
		command: goToCommand(finding.evidence[0].anchor.rva, finding.evidence[0].endRva),
	};
}

function evidenceItem(finding: IDelverFinding, index: number): ITreeItem {
	const evidence = finding.evidence[index];
	const start = wireAddress(evidence.anchor.rva);
	const end = evidence.endRva === undefined ? undefined : wireAddress(evidence.endRva);
	return {
		handle: `delver.review.evidence.${finding.id}.${index}`,
		label: { label: evidence.description },
		description: end === undefined ? start : `${start}–${end}`,
		tooltip: evidence.description,
		themeIcon: ThemeIcon.fromId(Codicon.location.id),
		collapsibleState: (evidence.sourceCallIds?.length ?? 0) > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
		command: goToCommand(evidence.anchor.rva, evidence.endRva),
	};
}

function evidenceFromHandle(handle: string, findings: readonly IDelverFinding[]) {
	const match = /^delver\.review\.evidence\.(.+)\.(\d+)$/.exec(handle);
	if (!match) {
		return undefined;
	}
	return findings.find(finding => finding.id === match[1])?.evidence[Number(match[2])];
}

function toolCallItem(parentHandle: string, call: IDelverToolCallRecord): ITreeItem {
	return {
		handle: `${parentHandle}.call.${call.callId}`,
		label: { label: call.capability },
		description: call.callId,
		tooltip: localize('delverReviewToolCallTooltip', "Tool call {0} completed in {1} ms", call.callId, call.finishedAt - call.startedAt),
		themeIcon: ThemeIcon.fromId(Codicon.link.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_REVIEW_OPEN_TOOL_CALL_COMMAND,
			title: localize('delverReviewOpenToolCall', "Open Tool Call"),
			arguments: [call.contentHash, call.callId],
		},
	};
}

function proposalLabel(edit: IEdit, subject: string): string {
	switch (edit.op) {
		case EditOp.Rename:
			return localize('delverReviewRename', "Rename {0} to {1}", subject, String(edit.value));
		case EditOp.Comment:
			return localize('delverReviewComment', "Comment at {0}: {1}", subject, String(edit.value));
		case EditOp.Tags:
			return localize('delverReviewTags', "Tags at {0}: {1}", subject, Array.isArray(edit.value) ? edit.value.join(', ') : String(edit.value));
		case EditOp.DataType:
			return localize('delverReviewDataType', "Data Type at {0}: {1}", subject, String(edit.value));
		case EditOp.FunctionPrototype:
			return localize('delverReviewFunctionPrototype', "Function Prototype at {0}: {1}", subject, String(edit.value));
		case EditOp.CompositeType:
			return localize('delverReviewCompositeType', "Type {0}: {1}", subject, compositeSummary(edit.value));
		case EditOp.FunctionBounds:
			return functionBoundsLabel(edit.value, subject);
	}
}

/**
 * What a function correction actually asks for, in words.
 *
 * The stored value is canonical JSON, which is right for a durable record and
 * useless in a tree. A reviewer deciding whether to accept a correction needs
 * to know it will add a function or take one away — that is the whole
 * decision — and reading `{"kind":"undefine"}` off a row does not tell them
 * so at a glance.
 */
function functionBoundsLabel(value: IEdit['value'], subject: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		return localize('delverReviewFunctionBoundsCleared', "Clear the function correction at {0}", subject);
	}
	try {
		const correction = JSON.parse(value) as { kind?: string; endRva?: string };
		if (correction.kind === 'data' && correction.endRva !== undefined) {
			return localize('delverReviewFunctionData', "Treat {0} through {1} as data, not code", subject, wireAddress(BigInt(correction.endRva)));
		}
		if (correction.kind === 'undefine') {
			return localize('delverReviewFunctionUndefine', "Remove function at {0}", subject);
		}
		if (correction.kind === 'define') {
			return correction.endRva === undefined
				? localize('delverReviewFunctionDefine', "Define function at {0}", subject)
				: localize('delverReviewFunctionDefineRange', "Define function at {0} (ends {1})", subject, wireAddress(BigInt(correction.endRva)));
		}
	} catch {
		// Fall through to the unreadable row below: `JSON.parse` and `BigInt`
		// both throw here, and both mean the same thing.
	}
	// Shown rather than thrown, like an unreadable layout: a row that cannot be
	// summarized is still one the reviewer must be able to see and reject.
	return localize('delverReviewFunctionBoundsUnreadable', "Unreadable function correction at {0}", subject);
}

/**
 * A one-line summary of a composite layout for the review row.
 *
 * The stored value is canonical JSON, which is the right durable form and the
 * wrong thing to put in a tree label. A reviewer deciding whether to accept a
 * struct wants its shape, not its serialization; the full layout is what they
 * accept, and it is one click away in the log.
 */
function compositeSummary(value: IEdit['value']): string {
	if (typeof value !== 'string' || value.length === 0) {
		return localize('delverReviewCompositeCleared', "cleared");
	}
	try {
		const layout = JSON.parse(value) as { kind?: string; size?: number; fields?: readonly unknown[] };
		return localize('delverReviewCompositeSummary', "{0}, {1} bytes, {2} fields", String(layout.kind ?? 'struct'), Number(layout.size ?? 0), layout.fields?.length ?? 0);
	} catch {
		// Shown rather than thrown: a row that cannot be summarized is still a
		// row the reviewer must be able to see and reject.
		return localize('delverReviewCompositeUnreadable', "unreadable layout");
	}
}

function goToCommand(start: bigint, end?: bigint): ITreeItem['command'] {
	return {
		id: DELVER_REVIEW_GO_TO_COMMAND,
		title: localize('delverReviewGoToEvidence', "Go to Evidence"),
		arguments: [wireAddress(start), end === undefined ? undefined : wireAddress(end)],
	};
}

function wireAddress(address: bigint): string {
	return `0x${address.toString(16).toUpperCase()}`;
}
