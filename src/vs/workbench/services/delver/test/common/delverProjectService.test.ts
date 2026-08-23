/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { IDelverFindingDecisionWire, IDelverFindingDraft, IDelverFindingWire } from '../../../../../platform/delver/common/findings.js';
import {
	IDelverProjectHandle,
	IDelverProjectSnapshot,
	IDelverProjectStoreService,
} from '../../../../../platform/delver/common/delverProjectStoreService.js';
import { IDelverToolCallRecordWire } from '../../../../../platform/delver/common/delverToolCall.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import { DelverProjectService } from '../../common/delverProjectService.js';

const HASH = 'a'.repeat(64);

class FakeProjectStore implements Partial<IDelverProjectStoreService> {
	readonly handle: IDelverProjectHandle = {
		projectId: 'project-1',
		path: 'C:\\projects\\sample.delverdb',
		metadata: metadata(),
	};
	readonly appendedDecisions: IDelverFindingDecisionWire[] = [];
	readonly appendedFindings: IDelverFindingWire[] = [];
	readonly appendedToolCalls: IDelverToolCallRecordWire[] = [];
	snapshot = snapshot();

	async open(): Promise<IDelverProjectHandle> { return this.handle; }
	async loadSnapshot(): Promise<IDelverProjectSnapshot> { return this.snapshot; }
	async appendFindingDecisions(_projectId: string, decisions: readonly IDelverFindingDecisionWire[]): Promise<void> {
		this.appendedDecisions.push(...decisions);
	}
	async appendFindings(_projectId: string, findings: readonly IDelverFindingWire[]): Promise<void> {
		this.appendedFindings.push(...findings);
	}
	async appendToolCalls(_projectId: string, calls: readonly IDelverToolCallRecordWire[]): Promise<void> {
		this.appendedToolCalls.push(...calls);
	}
	async close(): Promise<void> { }
}

suite('DelverProjectService findings', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('retains and decides untitled findings with append-only events', async () => {
		const { service, store } = createService();
		disposables.add(service);
		const events: string[] = [];
		disposables.add(service.onDidChangeFindings(event => events.push(`${event.kind}:${event.findingIds.length}`)));

		const [finding] = await service.reportFindings(HASH, [draft()]);
		const [decision] = await service.resolveFindings(HASH, [finding.id], 'accepted');

		assert.deepStrictEqual({
			pending: service.pendingFindings(HASH).length,
			decision: service.findingDecisionFor(HASH, finding.id),
			events,
			persisted: store.appendedDecisions.length,
		}, {
			pending: 0,
			decision: {
				id: decision.id,
				findingId: finding.id,
				contentHash: HASH,
				at: decision.at,
				author: { kind: 'human', id: 'local' },
				outcome: 'accepted',
			},
			events: ['reported:1', 'decided:1'],
			persisted: 0,
		});
		await assert.rejects(() => service.resolveFindings(HASH, [finding.id], 'rejected'), /already been decided/);
	});

	test('restores pending findings and autosaves their human decisions', async () => {
		const { service, store } = createService();
		disposables.add(service);
		const restored = findingWire();
		store.snapshot = { ...snapshot(), findings: [restored] };

		await service.openProject(store.handle.path);
		const [decision] = await service.resolveFindings(HASH, [restored.id], 'rejected', { kind: 'human', id: 'analyst' });

		assert.deepStrictEqual({
			pending: service.pendingFindings(HASH).length,
			persisted: store.appendedDecisions,
		}, {
			pending: 0,
			persisted: [{ ...decision }],
		});
	});

	test('persists tool calls and requires cited evidence calls to exist', async () => {
		const { service, store } = createService();
		disposables.add(service);
		await service.openProject(store.handle.path);
		await service.recordToolCall(toolCall());
		const [finding] = await service.reportFindings(HASH, [{
			...draft(),
			evidence: [{ ...draft().evidence[0], sourceCallIds: ['call-decompile-1'] }],
		}]);

		assert.deepStrictEqual({
			calls: service.toolCallsFor(HASH).map(call => call.callId),
			persistedCalls: store.appendedToolCalls.map(call => call.callId),
			persistedFindingCalls: store.appendedFindings[0].evidence[0].sourceCallIds,
			findingCalls: finding.evidence[0].sourceCallIds,
		}, {
			calls: ['call-decompile-1'],
			persistedCalls: ['call-decompile-1'],
			persistedFindingCalls: ['call-decompile-1'],
			findingCalls: ['call-decompile-1'],
		});
		await assert.rejects(() => service.reportFindings(HASH, [{
			...draft(), evidence: [{ ...draft().evidence[0], sourceCallIds: ['missing-call'] }],
		}]), /unknown tool call/);
	});
});

function createService(): { service: DelverProjectService; store: FakeProjectStore } {
	const store = new FakeProjectStore();
	const interpretation = {
		onDidChange: Event.None,
		loadFromProject: () => undefined,
		logFor: () => [],
	} as unknown as IDelverInterpretationService;
	return {
		store,
		service: new DelverProjectService(
			store as unknown as IDelverProjectStoreService,
			{} as IDelverAnalysisService,
			interpretation,
			{} as IFileDialogService,
			{ error: async () => undefined } as unknown as IDialogService,
		),
	};
}

function draft(): IDelverFindingDraft {
	return {
		author: { kind: 'model', id: 'model-a' },
		title: 'Header parser',
		description: 'The function parses an input header.',
		severity: 'info',
		confidence: 0.8,
		status: 'proposed',
		evidence: [{ kind: 'range', anchor: { kind: 'image', contentHash: HASH, rva: 0x1000n }, description: 'Header read.' }],
		provenance: { capability: 'delver_report_finding', callId: 'call-1' },
	};
}

function findingWire(): IDelverFindingWire {
	return {
		id: 'finding-1',
		at: 100,
		author: { kind: 'model', id: 'model-a' },
		title: 'Header parser',
		description: 'The function parses an input header.',
		severity: 'info',
		confidence: 0.8,
		status: 'proposed',
		anchors: [{ kind: 'image', contentHash: HASH, rva: '0x1000' }],
		evidence: [{ kind: 'range', anchor: { kind: 'image', contentHash: HASH, rva: '0x1000' }, description: 'Header read.' }],
		provenance: { capability: 'delver_report_finding', callId: 'call-1' },
	};
}

function toolCall(): IDelverToolCallRecordWire {
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

function metadata() {
	return {
		schemaVersion: 5,
		contentHash: HASH,
		displayName: 'sample.exe',
		currentRevisionId: HASH,
		createdAt: 1,
		updatedAt: 1,
	};
}

function snapshot(): IDelverProjectSnapshot {
	return {
		metadata: metadata(),
		interpretations: [],
		findings: [],
		findingDecisions: [],
		toolCalls: [],
	};
}
