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

export const DELVER_REVIEW_VIEW_ID = 'delver.view.review';
export const DELVER_REVIEW_GO_TO_COMMAND = 'delver.review.goTo';
export const DELVER_REVIEW_OPEN_TOOL_CALL_COMMAND = 'delver.review.openToolCall';
export const DELVER_REVIEW_PROPOSAL_CONTEXT = 'delver-review-proposal';
export const DELVER_REVIEW_FINDING_CONTEXT = 'delver-review-finding';

const PROPOSALS_HANDLE = 'delver.review.proposals';
const FINDINGS_HANDLE = 'delver.review.findings';

/** Pure tree projection for pending model-authored work. */
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
				...(this.proposals.length > 0 ? [groupItem(PROPOSALS_HANDLE, localize('delverReviewProposals', "Interpretation Proposals"), this.proposals.length)] : []),
				...(this.findings.length > 0 ? [groupItem(FINDINGS_HANDLE, localize('delverReviewFindings', "Findings"), this.findings.length)] : []),
			];
		}
		if (element.handle === PROPOSALS_HANDLE) {
			return this.proposals.map(proposalItem);
		}
		if (element.handle === FINDINGS_HANDLE) {
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

function groupItem(handle: string, label: string, count: number): ITreeItem {
	return {
		handle,
		label: { label },
		description: String(count),
		themeIcon: ThemeIcon.fromId(Codicon.checklist.id),
		collapsibleState: TreeItemCollapsibleState.Expanded,
	};
}

function proposalItem(edit: IEdit): ITreeItem {
	const address = wireAddress(edit.anchor.rva);
	return {
		handle: `delver.review.proposal.${edit.seq}`,
		label: { label: proposalLabel(edit, address) },
		description: edit.author.id,
		tooltip: localize('delverReviewProposalTooltip', "Proposed by {0} at {1}", edit.author.id, address),
		contextValue: DELVER_REVIEW_PROPOSAL_CONTEXT,
		themeIcon: ThemeIcon.fromId(Codicon.edit.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: goToCommand(edit.anchor.rva),
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

function proposalLabel(edit: IEdit, address: string): string {
	switch (edit.op) {
		case EditOp.Rename:
			return localize('delverReviewRename', "Rename {0} to {1}", address, String(edit.value));
		case EditOp.Comment:
			return localize('delverReviewComment', "Comment at {0}: {1}", address, String(edit.value));
		case EditOp.Tags:
			return localize('delverReviewTags', "Tags at {0}: {1}", address, Array.isArray(edit.value) ? edit.value.join(', ') : String(edit.value));
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
