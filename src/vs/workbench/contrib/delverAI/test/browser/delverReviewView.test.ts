/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createDelverFinding } from '../../../../../platform/delver/common/findings.js';
import { EditOp, EditStatus, IEdit } from '../../../../../platform/delver/common/interpretation.js';
import { IDelverToolCallRecord } from '../../../../../platform/delver/common/delverToolCall.js';
import { ITreeItem } from '../../../../common/views.js';
import {
	DelverReviewTreeDataProvider,
	findingIdFromHandle,
	proposalSequenceFromHandle,
} from '../../browser/delverReviewView.js';
import { delverToolCallResource, formatDelverToolCallDocument } from '../../browser/delverToolCallContentProvider.js';

const HASH = 'a'.repeat(64);

suite('Delver Review View', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects pending proposals and findings into navigable review rows', async () => {
		const provider = new DelverReviewTreeDataProvider();
		provider.setPending([proposal()], [finding()], [toolCall()]);

		const roots = await provider.getChildren();
		const proposals = await provider.getChildren(roots[0]);
		const findings = await provider.getChildren(roots[1]);
		const evidence = await provider.getChildren(findings[0]);
		const calls = await provider.getChildren(evidence[0]);

		assert.deepStrictEqual({
			roots: roots.map(item => ({ handle: item.handle, label: item.label?.label, description: item.description })),
			proposal: summarize(proposals[0]),
			finding: summarize(findings[0]),
			evidence: summarize(evidence[0]),
			call: summarize(calls[0]),
			proposalSeq: proposalSequenceFromHandle(proposals[0].handle),
			findingId: findingIdFromHandle(findings[0].handle),
		}, {
			roots: [
				{ handle: 'delver.review.proposals', label: 'Interpretation Proposals', description: '1' },
				{ handle: 'delver.review.findings', label: 'Findings', description: '1' },
			],
			proposal: {
				handle: 'delver.review.proposal.7',
				label: 'Rename 0x1000 to parse_header',
				description: 'model-a',
				command: ['0x1000', undefined],
			},
			finding: {
				handle: 'delver.review.finding.finding-1',
				label: 'Header parser',
				description: 'suspicious · 85%',
				command: ['0x1000', '0x1010'],
			},
			evidence: {
				handle: 'delver.review.evidence.finding-1.0',
				label: 'The loop consumes header fields.',
				description: '0x1000–0x1010',
				command: ['0x1000', '0x1010'],
			},
			call: {
				handle: 'delver.review.evidence.finding-1.0.call.call-decompile-1',
				label: 'delver_decompile',
				description: 'call-decompile-1',
				command: [HASH, 'call-decompile-1'],
			},
			proposalSeq: 7,
			findingId: 'finding-1',
		});
	});

	test('formats a cited call as a stable JSON evidence document', () => {
		const call = toolCall();
		const resource = delverToolCallResource(call);
		const document = JSON.parse(formatDelverToolCallDocument(call));

		assert.deepStrictEqual({
			resource: { scheme: resource.scheme, path: resource.path, identity: JSON.parse(resource.query) },
			document,
		}, {
			resource: {
				scheme: 'delver-tool-call',
				path: '/delver_decompile-call-decompile-1.json',
				identity: { contentHash: HASH, callId: 'call-decompile-1' },
			},
			document: {
				schemaVersion: 1,
				callId: 'call-decompile-1',
				capability: 'delver_decompile',
				contentHash: HASH,
				caller: { kind: 'model', id: 'model-a' },
				startedAt: 100,
				finishedAt: 125,
				durationMs: 25,
				request: { address: '0x1000' },
				result: { ok: true },
			},
		});
	});

	test('has no roots when no work is pending', async () => {
		const provider = new DelverReviewTreeDataProvider();
		assert.deepStrictEqual(await provider.getChildren(), []);
	});
});

function proposal(): IEdit {
	return {
		seq: 7,
		at: 100,
		author: { kind: 'model', id: 'model-a' },
		anchor: { kind: 'image', contentHash: HASH, rva: 0x1000n },
		op: EditOp.Rename,
		value: 'parse_header',
		status: EditStatus.Proposed,
	};
}

function finding() {
	return createDelverFinding('finding-1', 200, {
		author: { kind: 'model', id: 'model-a' },
		title: 'Header parser',
		description: 'The function parses an input header.',
		severity: 'suspicious',
		confidence: 0.85,
		status: 'proposed',
		evidence: [{
			kind: 'range',
			anchor: { kind: 'image', contentHash: HASH, rva: 0x1000n },
			endRva: 0x1010n,
			description: 'The loop consumes header fields.',
			sourceCallIds: ['call-decompile-1'],
		}],
		provenance: { capability: 'delver_report_finding', callId: 'call-1' },
	});
}

function toolCall(): IDelverToolCallRecord {
	return {
		callId: 'call-decompile-1',
		capability: 'delver_decompile',
		contentHash: HASH,
		caller: { kind: 'model', id: 'model-a' },
		startedAt: 100,
		finishedAt: 125,
		requestJson: '{"address":"0x1000"}',
		resultJson: '{"ok":true}',
	};
}

function summarize(item: ITreeItem) {
	return {
		handle: item.handle,
		label: item.label?.label,
		description: item.description,
		command: item.command?.arguments,
	};
}
