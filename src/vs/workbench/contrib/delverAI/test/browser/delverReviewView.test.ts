/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createDelverFinding } from '../../../../../platform/delver/common/findings.js';
import { EditOp, EditStatus, IEdit } from '../../../../../platform/delver/common/interpretation.js';
import { IDelverToolCallRecord } from '../../../../../platform/delver/common/delverToolCall.js';
import { ITreeItem, IViewDescriptorService } from '../../../../common/views.js';
import { DelverSurfaceId } from '../../../../services/delver/browser/delverSurface.js';
import { allDelverSurfaces } from '../../../../services/delver/browser/delverSurfaceRegistry.js';
import { IDelverInterpretationService } from '../../../../services/delver/common/delverInterpretationService.js';
import { IDelverProjectService } from '../../../../services/delver/common/delverProjectService.js';
import { IDelverSessionService } from '../../../../services/delver/common/delverSessionService.js';
import { ViewDescriptorService } from '../../../../services/views/browser/viewDescriptorService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DelverReviewViewContribution } from '../../browser/delverReview.contribution.js';
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
			roots: roots.map(item => ({ handle: item.handle, label: item.label?.label, description: item.description, contextValue: item.contextValue })),
			proposal: summarize(proposals[0]),
			finding: summarize(findings[0]),
			evidence: summarize(evidence[0]),
			call: summarize(calls[0]),
			proposalSeq: proposalSequenceFromHandle(proposals[0].handle),
			findingId: findingIdFromHandle(findings[0].handle),
		}, {
			roots: [
				{ handle: 'delver.review.proposals', label: 'Interpretation Proposals', description: '1', contextValue: 'delver-review-proposals' },
				{ handle: 'delver.review.findings', label: 'Findings', description: '1', contextValue: 'delver-review-findings' },
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

	test('says what a function correction will do instead of showing its JSON', async () => {
		// A reviewer decides whether a function appears or disappears. Reading
		// `{"kind":"undefine"}` off a tree row does not tell them which.
		const provider = new DelverReviewTreeDataProvider();
		provider.setPending([
			boundsProposal(8, '{"kind":"define","endRva":"0x1ac0"}'),
			boundsProposal(9, '{"kind":"define"}'),
			boundsProposal(10, '{"kind":"undefine"}'),
			boundsProposal(11, '{"kind":"define","endRva":'),
		], []);

		const roots = await provider.getChildren();
		const rows = await provider.getChildren(roots[0]);

		assert.deepStrictEqual(rows.map(row => row.label?.label), [
			'Define function at 0x1AB0 (ends 0x1AC0)',
			'Define function at 0x1AB0',
			'Remove function at 0x1AB0',
			'Unreadable function correction at 0x1AB0',
		]);
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

function boundsProposal(seq: number, value: string): IEdit {
	return {
		seq,
		at: 100,
		author: { kind: 'model', id: 'model-a' },
		anchor: { kind: 'image', contentHash: HASH, rva: 0x1ab0n },
		op: EditOp.FunctionBounds,
		value,
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

suite('Delver Review View contribution lifetime', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('disposing the contribution releases its tree view and its surface', () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IViewDescriptorService, disposables.add(instantiationService.createInstance(ViewDescriptorService)));
		instantiationService.stub(IDelverSessionService, {
			activeSession: undefined,
			onDidChangeActiveSession: Event.None,
		});
		instantiationService.stub(IDelverInterpretationService, {
			onDidChange: Event.None,
			pendingProposals: () => [],
		});
		instantiationService.stub(IDelverProjectService, {
			onDidChangeFindings: Event.None,
			pendingFindings: () => [],
			toolCallsFor: () => [],
		});

		// The tree view is covered by the suite's disposable tracker: it is
		// created here and nothing else can release it, so a contribution that
		// forgets to register it fails this test on teardown. The surface has to
		// go with it — a `SyncDescriptor` left in the registry lets the workspace
		// editor build a segment over a dead tree.
		const contribution = instantiationService.createInstance(DelverReviewViewContribution);
		const registeredWhileAlive = allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Review);
		contribution.dispose();

		assert.deepStrictEqual(
			{
				registeredWhileAlive,
				registeredAfterDispose: allDelverSurfaces().some(surface => surface.id === DelverSurfaceId.Review),
			},
			{ registeredWhileAlive: true, registeredAfterDispose: false },
		);
	});
});

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
