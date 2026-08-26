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
	IDelverFunctionMigrationMapping,
	IDelverProjectHandle,
	IDelverProjectRevision,
	IDelverProjectSnapshot,
	IDelverProjectStoreService,
} from '../../../../../platform/delver/common/delverProjectStoreService.js';
import { editFromWire, IInterpretationEditWire } from '../../../../../platform/delver/common/delverInterpretationStoreService.js';
import { IDelverToolCallRecordWire } from '../../../../../platform/delver/common/delverToolCall.js';
import { IDelverNamedSignatureDraft, IDelverNamedSignatureWire } from '../../../../../platform/delver/common/delverSignature.js';
import { Anchor, EditOp, EditStatus, EditValue, IAuthor, IEdit, IInterpretationAt, InterpretationLog } from '../../../../../platform/delver/common/interpretation.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import { DelverProjectService, IDelverProjectSession } from '../../common/delverProjectService.js';

const HASH = 'a'.repeat(64);
const OLD_HASH = 'b'.repeat(64);

class FakeProjectStore implements Partial<IDelverProjectStoreService> {
	readonly handle: IDelverProjectHandle = {
		projectId: 'project-1',
		path: 'C:\\projects\\sample.delverdb',
		metadata: metadata(),
	};
	readonly appendedDecisions: IDelverFindingDecisionWire[] = [];
	readonly appendedFindings: IDelverFindingWire[] = [];
	readonly appendedToolCalls: IDelverToolCallRecordWire[] = [];
	readonly upsertedSignatures: IDelverNamedSignatureWire[] = [];
	readonly deletedSignatures: { contentHash: string; signatureId: string }[] = [];
	readonly migrationMappings: IDelverFunctionMigrationMapping[] = [];
	snapshot = snapshot();
	revisions: IDelverProjectRevision[] = [{
		revisionId: HASH,
		contentHash: HASH,
		displayName: 'sample.exe',
		createdAt: 2,
	}];
	readonly revisionSnapshots = new Map<string, IDelverProjectSnapshot>();

	async open(): Promise<IDelverProjectHandle> { return this.handle; }
	async loadSnapshot(_projectId?: string, revisionId?: string): Promise<IDelverProjectSnapshot> {
		return revisionId ? this.revisionSnapshots.get(revisionId) ?? this.snapshot : this.snapshot;
	}
	async listRevisions(): Promise<readonly IDelverProjectRevision[]> { return this.revisions; }
	async appendFindingDecisions(_projectId: string, decisions: readonly IDelverFindingDecisionWire[]): Promise<void> {
		this.appendedDecisions.push(...decisions);
	}
	async appendFindings(_projectId: string, findings: readonly IDelverFindingWire[]): Promise<void> {
		this.appendedFindings.push(...findings);
	}
	async appendToolCalls(_projectId: string, calls: readonly IDelverToolCallRecordWire[]): Promise<void> {
		this.appendedToolCalls.push(...calls);
	}
	async upsertSignatures(_projectId: string, signatures: readonly IDelverNamedSignatureWire[]): Promise<void> {
		this.upsertedSignatures.push(...signatures);
	}
	async deleteSignature(_projectId: string, contentHash: string, signatureId: string): Promise<boolean> {
		this.deletedSignatures.push({ contentHash, signatureId });
		return true;
	}
	async storeFunctionMigrationMappings(_projectId: string, mappings: readonly IDelverFunctionMigrationMapping[]): Promise<void> {
		this.migrationMappings.push(...mappings);
	}
	async close(): Promise<void> { }
}

class FakeInterpretationService implements Partial<IDelverInterpretationService> {
	readonly onDidChange = Event.None;
	private readonly logs = new Map<string, InterpretationLog>();

	loadFromProject(contentHash: string, edits: readonly IInterpretationEditWire[]): void {
		this.logs.set(contentHash, InterpretationLog.from(edits.map(editFromWire)));
	}

	unload(contentHash: string): void {
		this.logs.delete(contentHash);
	}

	at(anchor: Anchor): IInterpretationAt | undefined {
		return this.logs.get(anchor.contentHash)?.at(anchor);
	}

	async edit(anchor: Anchor, op: EditOp, value: EditValue, author: IAuthor): Promise<IEdit> {
		return this.log(anchor.contentHash).append({ anchor, op, value, author });
	}

	async propose(anchor: Anchor, op: EditOp, value: EditValue, author: IAuthor): Promise<IEdit> {
		return this.log(anchor.contentHash).append({ anchor, op, value, author, status: EditStatus.Proposed });
	}

	pendingProposals(contentHash: string): readonly IEdit[] {
		return this.logs.get(contentHash)?.pendingProposals() ?? [];
	}

	logFor(contentHash: string): readonly IEdit[] {
		return this.logs.get(contentHash)?.log ?? [];
	}

	private log(contentHash: string): InterpretationLog {
		let log = this.logs.get(contentHash);
		if (!log) {
			log = new InterpretationLog();
			this.logs.set(contentHash, log);
		}
		return log;
	}
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

	test('closing a project drops its authored interpretation from the cache', async () => {
		// A project's log is authored *in that project*. Leaving it cached made
		// the next plain open of the same bytes show the closed project's names
		// — and saving would have written them into a new project as though the
		// analyst had authored them there.
		const { service, interpretation } = createService();
		disposables.add(service);
		const anchor = { kind: 'image', contentHash: HASH, rva: 0x1000n } as const;
		interpretation.loadFromProject(HASH, [
			interpretationWire(HASH, '0x1000', EditOp.Rename, 'decrypt_config', 1),
		]);

		const before = interpretation.at(anchor)?.name;
		await service.close({ contentHash: HASH } as IDelverProjectSession);

		assert.deepStrictEqual(
			{ before, after: interpretation.at(anchor)?.name },
			{ before: 'decrypt_config', after: undefined },
		);
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

	test('replaces named signatures case-insensitively while preserving their stable id', async () => {
		const { service, store } = createService();
		disposables.add(service);
		const events: string[] = [];
		disposables.add(service.onDidChangeSignatures(event => events.push(`${event.contentHash}:${event.signatureIds.length}`)));
		await service.openProject(store.handle.path);
		const first = await service.saveSignature(HASH, signatureDraft('decrypt_config', 0.7));
		const replaced = await service.saveSignature(HASH, signatureDraft('DECRYPT_CONFIG', 0.9));

		assert.deepStrictEqual({
			ids: [first.id, replaced.id],
			retained: service.signaturesFor(HASH).map(signature => ({ name: signature.name, score: signature.qualityScore })),
			persisted: store.upsertedSignatures.map(signature => ({ id: signature.id, name: signature.name, score: signature.qualityScore })),
			events,
		}, {
			ids: [first.id, first.id],
			retained: [{ name: 'DECRYPT_CONFIG', score: 0.9 }],
			persisted: [
				{ id: first.id, name: 'decrypt_config', score: 0.7 },
				{ id: first.id, name: 'DECRYPT_CONFIG', score: 0.9 },
			],
			events: [`${HASH}:1`, `${HASH}:1`],
		});
	});

	test('renames and deletes signatures while preserving retained evidence', async () => {
		const { service, store } = createService();
		disposables.add(service);
		const events: string[] = [];
		disposables.add(service.onDidChangeSignatures(event => events.push(event.signatureIds[0])));
		await service.openProject(store.handle.path);
		const first = await service.saveSignature(HASH, signatureDraft('decrypt_config', 0.9));
		const second = await service.saveSignature(HASH, signatureDraft('parse_header', 0.8));
		const renamed = await service.renameSignature(HASH, first.id, 'decrypt_payload');
		await assert.rejects(() => service.renameSignature(HASH, first.id, 'PARSE_HEADER'), /already exists/);
		await service.deleteSignature(HASH, second.id);

		assert.deepStrictEqual({
			stableId: [first.id, renamed.id],
			retained: service.signaturesFor(HASH).map(signature => ({ id: signature.id, name: signature.name, pattern: signature.pattern })),
			persistedNames: store.upsertedSignatures.map(signature => signature.name),
			deleted: store.deletedSignatures,
			events,
		}, {
			stableId: [first.id, first.id],
			retained: [{ id: first.id, name: 'decrypt_payload', pattern: '55 48 89 e5' }],
			persistedNames: ['decrypt_config', 'parse_header', 'decrypt_payload'],
			deleted: [{ contentHash: HASH, signatureId: second.id }],
			events: [first.id, second.id, first.id, second.id],
		});
		await assert.rejects(() => service.deleteSignature(HASH, second.id), /no longer exists/);
	});

	test('loads saved signature evidence from older project revisions', async () => {
		const { service, store } = createService();
		disposables.add(service);
		store.revisions = [
			{ revisionId: 'oldest', contentHash: 'c'.repeat(64), displayName: 'sample-v1.exe', createdAt: 1 },
			{ revisionId: 'previous', contentHash: OLD_HASH, displayName: 'sample-v2.exe', createdAt: 2 },
			{ revisionId: HASH, contentHash: HASH, displayName: 'sample-v3.exe', createdAt: 3 },
		];
		store.revisionSnapshots.set('oldest', snapshotForRevision('c'.repeat(64), 'oldest', [signatureWire('init_runtime', 'c'.repeat(64), 'signature-oldest')]));
		store.revisionSnapshots.set('previous', snapshotForRevision(OLD_HASH, 'previous', [
			signatureWire('parse_header', OLD_HASH, 'signature-parse'),
			signatureWire('decrypt_config', OLD_HASH, 'signature-decrypt'),
		]));

		await service.openProject(store.handle.path);
		const historical = await service.historicalSignaturesFor(HASH);

		assert.deepStrictEqual(historical.map(item => ({
			revision: item.revision.revisionId,
			name: item.signature.name,
			contentHash: item.signature.contentHash,
		})), [
			{ revision: 'previous', name: 'decrypt_config', contentHash: OLD_HASH },
			{ revision: 'previous', name: 'parse_header', contentHash: OLD_HASH },
			{ revision: 'oldest', name: 'init_runtime', contentHash: 'c'.repeat(64) },
		]);
		assert.deepStrictEqual(await service.historicalSignaturesFor('d'.repeat(64)), []);
	});

	test('accepts a signature mapping, transfers missing interpretation, and proposes conflicts', async () => {
		const { service, store, interpretation } = createService();
		disposables.add(service);
		const sourceSignature = signatureWire('decrypt_config', OLD_HASH, 'signature-source');
		const targetSignature = {
			...signatureWire('decrypt_config', HASH, 'signature-target'),
			sourceCallId: 'generate-current',
			policy: 'cross-revision-stable' as const,
			functionRva: '0x2200',
			coveredStartRva: '0x2200',
			coveredEndRva: '0x2204',
		};
		const unboundTargetSignature = {
			...targetSignature,
			id: 'signature-target-unbound',
			name: 'decrypt_config_unbound',
			sourceCallId: 'generate-unbound',
		};
		store.snapshot = {
			...snapshot(),
			interpretations: [interpretationWire(HASH, '0x2200', EditOp.Comment, 'current comment', 1)],
			toolCalls: [
				toolCallWire('search-current', 'delver_search_bytes', {
					schemaVersion: 1,
					callId: 'search-current',
					capability: 'delver_search_bytes',
					provenance: [],
					completeness: 'complete',
					data: { pattern: sourceSignature.pattern, matches: [{ rva: '0x2200', section: '.text', bytesHex: '554889e5' }] },
				}),
				toolCallWire('generate-current', 'delver_make_signature', generationResult(sourceSignature)),
				toolCallWire('generate-unbound', 'delver_make_signature', generationResult(sourceSignature, 'different-signature')),
			],
			signatures: [targetSignature, unboundTargetSignature],
		};
		store.revisionSnapshots.set('revision-old', {
			...snapshotForRevision(OLD_HASH, 'revision-old', [sourceSignature]),
			interpretations: [
				interpretationWire(OLD_HASH, '0x1000', EditOp.Rename, 'decrypt_config', 1),
				interpretationWire(OLD_HASH, '0x1000', EditOp.Comment, 'source comment', 2),
				interpretationWire(OLD_HASH, '0x1000', EditOp.Tags, ['crypto', 'config'], 3),
			],
		});

		await service.openProject(store.handle.path);
		await assert.rejects(() => service.acceptSignatureMigration(HASH, {
			sourceRevisionId: 'revision-old',
			sourceSignatureId: sourceSignature.id,
			searchCallId: 'search-current',
			generatedCallId: 'generate-unbound',
			targetSignatureId: unboundTargetSignature.id,
		}), /not an exact bound cross-revision match/);
		const result = await service.acceptSignatureMigration(HASH, {
			sourceRevisionId: 'revision-old',
			sourceSignatureId: sourceSignature.id,
			searchCallId: 'search-current',
			generatedCallId: 'generate-current',
			targetSignatureId: targetSignature.id,
		});
		const repeated = await service.acceptSignatureMigration(HASH, {
			sourceRevisionId: 'revision-old',
			sourceSignatureId: sourceSignature.id,
			searchCallId: 'search-current',
			generatedCallId: 'generate-current',
			targetSignatureId: targetSignature.id,
		});
		const target = interpretation.at({ kind: 'image', contentHash: HASH, rva: 0x2200n });
		const proposal = interpretation.pendingProposals(HASH)[0];
		const mapping = store.migrationMappings[0];

		assert.deepStrictEqual({
			result,
			repeated,
			target,
			proposal: proposal && { op: proposal.op, value: proposal.value, author: proposal.author },
			mapping: mapping && { ...mapping, provenance: JSON.parse(mapping.provenance ?? '{}') },
		}, {
			result: { transferredCount: 2, proposedCount: 1, unchangedCount: 0 },
			repeated: { transferredCount: 0, proposedCount: 0, unchangedCount: 3 },
			target: { comment: 'current comment', name: 'decrypt_config', tags: ['crypto', 'config'] },
			proposal: { op: EditOp.Comment, value: 'source comment', author: { kind: 'import', id: 'signature:signature-source' } },
			mapping: {
				sourceRevisionId: 'revision-old',
				sourceRva: '0x1000',
				targetRevisionId: HASH,
				targetRva: '0x2200',
				method: 'signature',
				confidence: 0.9,
				status: 'accepted',
				provenance: {
					kind: 'named-signature',
					sourceContentHash: OLD_HASH,
					targetContentHash: HASH,
					sourceSignatureId: 'signature-source',
					targetSignatureId: 'signature-target',
					searchCallId: 'search-current',
					generatedCallId: 'generate-current',
					pattern: '55 48 89 e5',
				},
			},
		});
	});
});

function createService(): { service: DelverProjectService; store: FakeProjectStore; interpretation: FakeInterpretationService } {
	const store = new FakeProjectStore();
	const interpretation = new FakeInterpretationService();
	return {
		store,
		interpretation,
		service: new DelverProjectService(
			store as unknown as IDelverProjectStoreService,
			{} as IDelverAnalysisService,
			interpretation as unknown as IDelverInterpretationService,
			{} as IFileDialogService,
			{ error: async () => undefined } as unknown as IDialogService,
		),
	};
}

function interpretationWire(contentHash: string, rva: string, op: EditOp, value: EditValue, seq: number): IInterpretationEditWire {
	return {
		seq,
		at: seq,
		author: { kind: 'human', id: 'analyst' },
		anchor: { kind: 'image', contentHash, rva },
		op,
		value,
		status: EditStatus.Accepted,
	};
}

function toolCallWire(callId: string, capability: string, result: Readonly<Record<string, unknown>>): IDelverToolCallRecordWire {
	return {
		callId,
		capability,
		contentHash: HASH,
		startedAt: 1,
		finishedAt: 2,
		requestJson: '{}',
		resultJson: JSON.stringify(result),
	};
}

function generationResult(sourceSignature: IDelverNamedSignatureWire, selectedSignatureId = sourceSignature.id): Readonly<Record<string, unknown>> {
	return {
		completeness: 'complete',
		data: {
			target: { rva: '0x2200', name: 'decrypt_config' },
			policy: 'cross-revision-stable',
			pattern: sourceSignature.pattern,
			proof: { unique: true, matchCountExact: true, matchCount: 1, targetMatched: true },
			crossRevisionProof: {
				method: 'retained-exact-primary-signatures',
				revisionCount: 1,
				selectedEvidence: {
					sourceRevisionId: 'revision-old',
					sourceSignatureId: selectedSignatureId,
				},
				revisions: [{
					revisionId: 'revision-old',
					signatureId: sourceSignature.id,
					pattern: sourceSignature.pattern,
				}],
			},
		},
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

function signatureDraft(name: string, qualityScore: number): IDelverNamedSignatureDraft {
	return {
		name,
		contentHash: HASH,
		sourceCallId: 'call-signature-1',
		functionRva: '0x1000',
		functionName: 'SUB_1000',
		variant: 'primary',
		scope: 'executableSections',
		policy: 'relocation-stable',
		pattern: '55 48 89 e5',
		byteCount: 4,
		fixedByteCount: 4,
		wildcardByteCount: 0,
		coveredStartRva: '0x1000',
		coveredEndRva: '0x1004',
		wildcards: [],
		unique: true,
		matchCount: 1,
		matchCountExact: true,
		qualityScore,
		confidence: qualityScore >= 0.8 ? 'high' : 'medium',
	};
}

function signatureWire(name: string, contentHash: string, id: string): IDelverNamedSignatureWire {
	return {
		...signatureDraft(name, 0.9),
		id,
		contentHash,
		createdAt: 1,
		updatedAt: 1,
	};
}

function metadata() {
	return {
		schemaVersion: 6,
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
		signatures: [],
	};
}

function snapshotForRevision(contentHash: string, revisionId: string, signatures: readonly IDelverNamedSignatureWire[]): IDelverProjectSnapshot {
	return {
		...snapshot(),
		metadata: {
			...metadata(),
			contentHash,
			currentRevisionId: revisionId,
		},
		signatures,
	};
}
