/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Database } from '@vscode/sqlite3';
import { promises } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IDelverProjectTargetIdentity } from '../../common/delverProjectStoreService.js';
import { IXrefWire, XrefKindWire } from '../../common/protocol.generated.js';
import { IDelverFindingDecisionWire, IDelverFindingWire } from '../../common/findings.js';
import { IInterpretationEditWire } from '../../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus, IAuthor } from '../../common/interpretation.js';
import { IDelverToolCallRecordWire } from '../../common/delverToolCall.js';
import { IDelverNamedSignatureWire } from '../../common/delverSignature.js';
import { DelverProjectStoreService } from '../../node/delverProjectStoreService.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ANALYST: IAuthor = { kind: 'human', id: 'analyst' };

function target(contentHash = HASH_A): IDelverProjectTargetIdentity {
	return { contentHash, displayName: 'sample.exe', sourcePath: 'C:\\samples\\sample.exe', byteLength: 4096 };
}

function edit(contentHash = HASH_A): IInterpretationEditWire {
	return {
		seq: 1,
		at: 1_700_000_000_000,
		author: { kind: 'human', id: 'analyst' },
		anchor: { kind: 'image', contentHash, rva: '0x1000' },
		op: EditOp.Rename,
		value: 'entry',
		status: EditStatus.Accepted,
	};
}

function finding(contentHash = HASH_A, id = 'finding-1'): IDelverFindingWire {
	return {
		id,
		at: 1_700_000_000_100,
		author: { kind: 'model', id: 'test-model' },
		title: 'Embedded command-and-control endpoint',
		description: 'The function constructs a fixed network endpoint before connecting.',
		severity: 'suspicious',
		confidence: 0.87,
		status: 'proposed',
		anchors: [{ kind: 'image', contentHash, rva: '0x1000' }],
		evidence: [{
			kind: 'range',
			anchor: { kind: 'image', contentHash, rva: '0x1000' },
			endRva: '0x1010',
			description: 'Instructions load the endpoint string and call the connect wrapper.',
			sourceCallIds: [],
		}],
		provenance: { capability: 'delver_report_finding', callId: 'call-1' },
	};
}

function toolCall(contentHash = HASH_A, callId = 'call-decompile-1'): IDelverToolCallRecordWire {
	return {
		callId,
		capability: 'delver_decompile',
		contentHash,
		caller: { kind: 'model', id: 'test-model' },
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_000_025,
		requestJson: '{"address":"0x1000"}',
		resultJson: '{"ok":true}',
	};
}

function signature(contentHash = HASH_A, name = 'decrypt_config', id = 'signature-1'): IDelverNamedSignatureWire {
	return {
		id,
		name,
		contentHash,
		sourceCallId: 'call-signature-1',
		functionRva: '0x1000',
		functionName: 'SUB_1000',
		variant: 'primary',
		scope: 'executableSections',
		policy: 'relocation-stable',
		pattern: '55 48 89 e5 e8 ?? ?? ?? ??',
		byteCount: 9,
		fixedByteCount: 5,
		wildcardByteCount: 4,
		coveredStartRva: '0x1000',
		coveredEndRva: '0x1009',
		wildcards: [{
			instructionRva: '0x1004', instructionByteIndex: 1, length: 4,
			patternByteIndex: 5, reason: 'relativeBranch',
		}],
		unique: true,
		matchCount: 1,
		matchCountExact: true,
		qualityScore: 0.75,
		confidence: 'medium',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	};
}

function xref(from: string, to: string, kind = XrefKindWire.Call): IXrefWire {
	return { from, to, kind };
}

function findingDecision(contentHash = HASH_A, findingId = 'finding-1', id = 'decision-1'): IDelverFindingDecisionWire {
	return {
		id,
		findingId,
		contentHash,
		at: 1_700_000_000_200,
		author: { kind: 'human', id: 'analyst' },
		outcome: 'accepted',
	};
}

suite('DelverProjectStoreService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let testRoot: string;

	setup(async () => {
		testRoot = await promises.mkdtemp(join(tmpdir(), 'delver-project-test-'));
	});

	teardown(async () => {
		await promises.rm(testRoot, { recursive: true, force: true });
	});

	test('persists target identity and analysis without embedding target bytes', async () => {
		const path = join(testRoot, 'sample.delverdb');
		const service = new DelverProjectStoreService();
		const created = await service.create(path, target());
		await service.saveSnapshot(created.projectId, {
			imageInfo: JSON.stringify({ architecture: 'x86_64' }),
			functions: JSON.stringify({ functions: [{ rva: '0x1000' }, { rva: '0x2000' }] }),
			imports: JSON.stringify({ modules: [] }),
			exports: JSON.stringify({ exports: [] }),
			strings: JSON.stringify({ strings: ['hello'] }),
			decompiledFunctions: [{
				backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x001000',
				serialized: JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: 'return 0;' }),
			}, {
				backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x2000',
				serialized: JSON.stringify({ schemaVersion: 1, functionRva: '0x2000', text: 'return 1;' }),
			}],
		});
		await service.appendInterpretations(created.projectId, [edit()]);
		await service.appendToolCalls(created.projectId, [toolCall()]);
		await service.appendFindings(created.projectId, [finding()]);
		await service.appendFindingDecisions(created.projectId, [findingDecision()]);
		await service.appendSignatures(created.projectId, [signature()], ANALYST);
		await service.close(created.projectId);

		const reopened = await service.open(path, HASH_A);
		const snapshot = await service.loadSnapshot(reopened.projectId);
		const databaseBytes = await promises.readFile(path);
		await service.close(reopened.projectId);

		assert.deepStrictEqual({
			metadata: { ...snapshot.metadata, createdAt: 0, updatedAt: 0 },
			imageInfo: snapshot.imageInfo,
			functions: snapshot.functions,
			imports: snapshot.imports,
			exports: snapshot.exports,
			strings: snapshot.strings,
			decompiledFunctions: snapshot.decompiledFunctions,
			interpretations: snapshot.interpretations,
			findings: snapshot.findings,
			findingDecisions: snapshot.findingDecisions,
			toolCalls: snapshot.toolCalls,
			signatures: snapshot.signatures,
			containsPeHeader: databaseBytes.includes(Buffer.from('MZThis must not be persisted')),
		}, {
			metadata: { ...target(), schemaVersion: 8, currentRevisionId: HASH_A, createdAt: 0, updatedAt: 0 },
			imageInfo: JSON.stringify({ architecture: 'x86_64' }),
			functions: JSON.stringify({ functions: [{ rva: '0x1000' }, { rva: '0x2000' }] }),
			imports: JSON.stringify({ modules: [] }),
			exports: JSON.stringify({ exports: [] }),
			strings: JSON.stringify({ strings: ['hello'] }),
			decompiledFunctions: [{
				backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x1000',
				serialized: JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: 'return 0;' }),
			}, {
				backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x2000',
				serialized: JSON.stringify({ schemaVersion: 1, functionRva: '0x2000', text: 'return 1;' }),
			}],
			interpretations: [edit()],
			findings: [finding()],
			findingDecisions: [findingDecision()],
			toolCalls: [toolCall()],
			signatures: [signature()],
			containsPeHeader: false,
		});
	});

	test('partial saves replace supplied categories and retain all others', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'partial.delverdb'), target());
		await service.saveSnapshot(project.projectId, {
			functions: JSON.stringify({ revision: 1 }),
			strings: JSON.stringify({ revision: 1 }),
			decompiledFunctions: [{ backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x10', serialized: '{"revision":1}' }],
		});
		await service.saveSnapshot(project.projectId, {
			functions: JSON.stringify({ revision: 2 }),
			decompiledFunctions: [{ backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x10', serialized: '{"revision":2}' }],
		});

		const snapshot = await service.loadSnapshot(project.projectId);
		await service.close(project.projectId);
		assert.deepStrictEqual({
			functions: snapshot.functions,
			strings: snapshot.strings,
			decompiledFunctions: snapshot.decompiledFunctions,
		}, {
			functions: '{"revision":2}',
			strings: '{"revision":1}',
			decompiledFunctions: [{ backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x10', serialized: '{"revision":2}' }],
		});
	});

	test('rejects target mismatches and copies interpretation history only between matching targets', async () => {
		const service = new DelverProjectStoreService();
		const first = await service.create(join(testRoot, 'first.delverdb'), target());
		const second = await service.create(join(testRoot, 'second.delverdb'), target());
		const different = await service.create(join(testRoot, 'different.delverdb'), target(HASH_B));
		await service.appendInterpretations(first.projectId, [edit()]);
		await service.appendFindings(first.projectId, [finding()]);

		assert.strictEqual(await service.copyInterpretations(first.projectId, second.projectId), 1);
		assert.deepStrictEqual((await service.loadSnapshot(second.projectId)).interpretations, [edit()]);
		await assert.rejects(() => service.copyInterpretations(first.projectId, different.projectId), /different target bytes/);
		await assert.rejects(() => service.appendInterpretations(different.projectId, [edit()]), /different target bytes/);
		await assert.rejects(() => service.appendFindings(different.projectId, [finding()]), /different target bytes/);
		await assert.rejects(() => service.appendToolCalls(different.projectId, [toolCall()]), /different target bytes/);
		await assert.rejects(() => service.appendSignatures(different.projectId, [signature()], ANALYST), /different target bytes/);
		await service.appendToolCalls(first.projectId, [toolCall()]);
		await service.appendToolCalls(first.projectId, [toolCall()]);
		await assert.rejects(() => service.appendToolCalls(first.projectId, [{ ...toolCall(), resultJson: '{"ok":false}' }]), /conflicts with an existing record/);
		await assert.rejects(() => service.appendFindings(first.projectId, [finding(), finding()]), /duplicate ids/);
		await assert.rejects(() => service.appendFindingDecisions(first.projectId, [findingDecision(), findingDecision()]), /duplicate ids/);
		await assert.rejects(() => service.appendSignatures(first.projectId, [signature(), signature()], ANALYST), /duplicate names or ids/);
		await assert.rejects(() => service.appendSignatures(first.projectId, [{ ...signature(), coveredEndRva: '0x1008' }], ANALYST), /covered range does not match/);
		await service.appendSignatures(first.projectId, [signature(HASH_A, 'Änalysis')], ANALYST);
		await service.appendSignatures(first.projectId, [{ ...signature(HASH_A, 'änALYSIS'), qualityScore: 0.9, confidence: 'high', updatedAt: 1_700_000_000_001 }], ANALYST);
		await assert.rejects(() => service.appendSignatures(first.projectId, [signature(HASH_A, 'ÄNALYSIS', 'other-id')], ANALYST), /conflicts with an existing id/);
		await service.appendFindingDecisions(first.projectId, [findingDecision()]);
		await service.appendFindingDecisions(first.projectId, [findingDecision()]);
		await assert.rejects(() => service.appendFindingDecisions(first.projectId, [{
			...findingDecision(), id: 'conflicting-decision', outcome: 'rejected',
		}]), /already been decided/);
		assert.deepStrictEqual({
			findings: (await service.loadSnapshot(first.projectId)).findings,
			decisions: (await service.loadSnapshot(first.projectId)).findingDecisions,
			signatures: (await service.loadSnapshot(first.projectId)).signatures,
		}, {
			findings: [finding()],
			decisions: [findingDecision()],
			signatures: [{ ...signature(HASH_A, 'änALYSIS'), qualityScore: 0.9, confidence: 'high', updatedAt: 1_700_000_000_001 }],
		});

		await service.close(first.projectId);
		await service.close(second.projectId);
		await service.close(different.projectId);
		await assert.rejects(() => service.open(join(testRoot, 'first.delverdb'), HASH_B), /different target bytes/);
	});

	test('does not partially replace a snapshot when one payload is invalid', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'atomic.delverdb'), target());
		await service.saveSnapshot(project.projectId, { functions: '{"revision":1}' });
		await assert.rejects(() => service.saveSnapshot(project.projectId, {
			functions: '{"revision":2}', strings: 'not json',
		}), /Invalid JSON/);
		assert.strictEqual((await service.loadSnapshot(project.projectId)).functions, '{"revision":1}');
		await service.close(project.projectId);
	});

	test('renames and deletes named signatures without changing their stable id', async () => {
		const path = join(testRoot, 'signature-management.delverdb');
		const service = new DelverProjectStoreService();
		const project = await service.create(path, target());
		const original = signature(HASH_A, 'decrypt_config', 'signature-stable');
		const other = signature(HASH_A, 'parse_header', 'signature-other');
		await service.appendSignatures(project.projectId, [original, other], ANALYST);
		const renamed = { ...original, name: 'decrypt_payload', updatedAt: original.updatedAt + 1 };
		await service.appendSignatures(project.projectId, [renamed], ANALYST);
		await assert.rejects(
			() => service.appendSignatures(project.projectId, [{ ...renamed, name: 'PARSE_HEADER' }], ANALYST),
			/conflicts with an existing id/,
		);
		assert.strictEqual(await service.retireSignature(project.projectId, HASH_A, other.id, ANALYST), true);
		assert.strictEqual(await service.retireSignature(project.projectId, HASH_A, other.id, ANALYST), false);
		await service.close(project.projectId);

		const reopened = await service.open(path, HASH_A);
		const signatures = (await service.loadSnapshot(reopened.projectId)).signatures;
		await service.close(reopened.projectId);
		assert.deepStrictEqual(signatures, [renamed]);
	});

	test('persists cross-revision signature policy evidence', async () => {
		const path = join(testRoot, 'cross-revision-signature.delverdb');
		const service = new DelverProjectStoreService();
		const created = await service.create(path, target());
		await service.appendSignatures(created.projectId, [{ ...signature(), policy: 'cross-revision-stable' }], ANALYST);
		await service.close(created.projectId);

		const reopened = await service.open(path, HASH_A);
		const signatures = (await service.loadSnapshot(reopened.projectId)).signatures;
		await service.close(reopened.projectId);

		assert.deepStrictEqual(signatures, [{ ...signature(), policy: 'cross-revision-stable' }]);
	});

	test('retains independent snapshots for every target revision', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'revisions.delverdb'), target());
		await service.saveSnapshot(project.projectId, { functions: '{"build":"old"}' });
		await service.appendInterpretations(project.projectId, [edit(HASH_A)]);
		await service.appendFindings(project.projectId, [finding(HASH_A, 'old-finding')]);
		await service.appendSignatures(project.projectId, [signature(HASH_A, 'old-signature', 'signature-old')], ANALYST);
		await service.appendFindingDecisions(project.projectId, [findingDecision(HASH_A, 'old-finding', 'old-decision')]);
		const next = await service.addRevision(project.projectId, {
			...target(HASH_B), displayName: 'sample-2.exe', sourcePath: 'C:\\samples\\sample-2.exe', byteLength: 8192,
		}, { functions: '{"build":"new"}' });
		await service.appendInterpretations(project.projectId, [edit(HASH_B)]);
		await service.appendFindings(project.projectId, [finding(HASH_B, 'new-finding')]);
		await service.appendSignatures(project.projectId, [signature(HASH_B, 'new-signature', 'signature-new')], ANALYST);

		const revisions = await service.listRevisions(project.projectId);
		const oldSnapshot = await service.loadSnapshot(project.projectId, HASH_A);
		const newSnapshot = await service.loadSnapshot(project.projectId, next.revisionId);
		await service.close(project.projectId);

		assert.deepStrictEqual({
			revisions: revisions.map(revision => ({ ...revision, createdAt: 0 })),
			old: { hash: oldSnapshot.metadata.contentHash, functions: oldSnapshot.functions },
			current: { hash: newSnapshot.metadata.contentHash, functions: newSnapshot.functions },
			interpretationHashes: [oldSnapshot.interpretations[0]?.anchor.contentHash, newSnapshot.interpretations[0]?.anchor.contentHash],
			findingHashes: [oldSnapshot.findings[0]?.anchors[0]?.contentHash, newSnapshot.findings[0]?.anchors[0]?.contentHash],
			decisionHashes: [oldSnapshot.findingDecisions[0]?.contentHash, newSnapshot.findingDecisions[0]?.contentHash],
			signatureHashes: [oldSnapshot.signatures[0]?.contentHash, newSnapshot.signatures[0]?.contentHash],
		}, {
			revisions: [
				{ ...target(), revisionId: HASH_A, createdAt: 0 },
				{ ...target(HASH_B), displayName: 'sample-2.exe', sourcePath: 'C:\\samples\\sample-2.exe', byteLength: 8192, revisionId: HASH_B, createdAt: 0 },
			],
			old: { hash: HASH_A, functions: '{"build":"old"}' },
			current: { hash: HASH_B, functions: '{"build":"new"}' },
			interpretationHashes: [HASH_A, HASH_B],
			findingHashes: [HASH_A, HASH_B],
			decisionHashes: [HASH_A, undefined],
			signatureHashes: [HASH_A, HASH_B],
		});
	});

	test('rolls back a new revision and current selection when its snapshot is invalid', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'revision-rollback.delverdb'), target());
		await assert.rejects(() => service.addRevision(project.projectId, target(HASH_B), { functions: 'invalid json' }), /Invalid JSON/);

		const revisions = await service.listRevisions(project.projectId);
		const snapshot = await service.loadSnapshot(project.projectId);
		await service.close(project.projectId);
		assert.deepStrictEqual({ revisionIds: revisions.map(revision => revision.revisionId), current: snapshot.metadata.currentRevisionId }, {
			revisionIds: [HASH_A], current: HASH_A,
		});
	});

	test('stores revision mappings with normalized addresses, evidence and review status', async () => {
		const path = join(testRoot, 'mappings.delverdb');
		const service = new DelverProjectStoreService();
		const project = await service.create(path, target());
		await service.addRevision(project.projectId, target(HASH_B));
		await service.storeFunctionMigrationMappings(project.projectId, [{
			sourceRevisionId: HASH_A, sourceRva: '0x001000', targetRevisionId: HASH_B, targetRva: '0x002000',
			method: 'structural', confidence: 0.72, status: 'proposed', provenance: '{"algorithm":"cfg-v1"}',
		}]);
		await service.storeFunctionMigrationMappings(project.projectId, [{
			sourceRevisionId: HASH_A, sourceRva: '0x1000', targetRevisionId: HASH_B, targetRva: '0x2000',
			method: 'signature', confidence: 1, status: 'accepted', provenance: '{"signatureId":"known-routine"}',
		}]);
		await service.close(project.projectId);

		const reopened = await service.open(path);
		const mappings = await service.loadFunctionMigrationMappings(reopened.projectId, HASH_A, HASH_B);
		await service.close(reopened.projectId);
		assert.deepStrictEqual(mappings, [{
			sourceRevisionId: HASH_A, sourceRva: '0x1000', targetRevisionId: HASH_B, targetRva: '0x2000',
			method: 'signature', confidence: 1, status: 'accepted', provenance: '{"signatureId":"known-routine"}',
		}]);
	});

	test('reports an interpretation sequence that collides with a different stored edit', async () => {
		// Two windows replaying the same log both mint the same sequence. Whatever
		// resolves the collision must not resolve it by discarding one of them:
		// interpretation is the only thing in a project that cannot be recomputed,
		// and a save reporting success after dropping an edit loses it silently.
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'collision.delverdb'), target());
		await service.appendInterpretations(project.projectId, [edit()]);
		// Re-saving a log that is already stored stays idempotent: every project
		// save re-sends the whole log.
		await service.appendInterpretations(project.projectId, [edit()]);

		await assert.rejects(
			() => service.appendInterpretations(project.projectId, [{ ...edit(), value: 'second_window' }]),
			/sequence 1 conflicts with an edit already stored/,
		);
		await assert.rejects(
			() => service.appendInterpretations(project.projectId, [{ ...edit(), seq: 2 }, { ...edit(), seq: 2, value: 'twice' }]),
			/contains sequence 2 twice/,
		);

		const snapshot = await service.loadSnapshot(project.projectId);
		await service.close(project.projectId);
		assert.deepStrictEqual(snapshot.interpretations, [edit()]);
	});

	test('renaming and retiring a signature keeps every earlier record and its proof', async () => {
		const path = join(testRoot, 'signature-history.delverdb');
		const service = new DelverProjectStoreService();
		const project = await service.create(path, target());
		const original = signature(HASH_A, 'decrypt_config', 'signature-stable');
		const reproved = { ...original, name: 'decrypt_payload', sourceCallId: 'call-signature-2', updatedAt: original.updatedAt + 1 };
		await service.appendSignatures(project.projectId, [original], ANALYST);
		await service.appendSignatures(project.projectId, [reproved], ANALYST);
		// An unchanged re-save appends nothing, or a project save would bury the
		// history under copies of the current record.
		await service.appendSignatures(project.projectId, [reproved], ANALYST);
		const retired = await service.retireSignature(project.projectId, HASH_A, original.id, ANALYST);
		const current = (await service.loadSnapshot(project.projectId)).signatures;
		await service.close(project.projectId);

		assert.deepStrictEqual({ retired, current, records: await readSignatureRecords(path) }, {
			retired: true,
			current: [],
			records: [
				{ id: 'signature-stable', sourceCallId: 'call-signature-1', author: 'human:analyst', supersedes: null, tombstone: 0 },
				{ id: 'signature-stable', sourceCallId: 'call-signature-2', author: 'human:analyst', supersedes: 1, tombstone: 0 },
				{ id: 'signature-stable', sourceCallId: undefined, author: 'human:analyst', supersedes: 2, tombstone: 1 },
			],
		});
	});

	test('answers both xref directions from the retained table, with no sample in reach', async () => {
		const path = join(testRoot, 'xrefs.delverdb');
		const service = new DelverProjectStoreService();
		const project = await service.create(path, target());
		await service.saveXrefs(project.projectId, [
			xref('0x2010', '0x1000'),
			xref('0x2040', '0x1000', XrefKindWire.Jump),
			xref('0x1000', '0x3000', XrefKindWire.Data),
		], true);
		await service.close(project.projectId);

		const reopened = await service.open(path, HASH_A);
		const callers = await service.loadXrefs(reopened.projectId, '0x1000', 'to', 16);
		const callees = await service.loadXrefs(reopened.projectId, '0x1000', 'from', 16);
		const retained = await service.hasRetainedXrefs(reopened.projectId);
		await service.close(reopened.projectId);

		assert.deepStrictEqual({ callers, callees, retained }, {
			callers: {
				xrefs: [xref('0x2010', '0x1000'), xref('0x2040', '0x1000', XrefKindWire.Jump)],
				total: 2, truncated: false, complete: true,
			},
			callees: {
				xrefs: [xref('0x1000', '0x3000', XrefKindWire.Data)],
				total: 1, truncated: false, complete: true,
			},
			retained: true,
		});
	});

	test('an address with no references is a different answer from a project that retained nothing', async () => {
		// The whole point of recording retention: an unretained project must not
		// answer a confident zero for an address whose references were never
		// exported, which is a false denial an analyst has no way to see through.
		const service = new DelverProjectStoreService();
		const retained = await service.create(join(testRoot, 'retained.delverdb'), target());
		await service.saveXrefs(retained.projectId, [xref('0x2010', '0x1000')], true);
		const bare = await service.create(join(testRoot, 'bare.delverdb'), target(HASH_B));

		const answered = await service.loadXrefs(retained.projectId, '0x9000', 'to', 16);
		const unanswerable = await service.loadXrefs(bare.projectId, '0x9000', 'to', 16);
		const partial = await service.create(join(testRoot, 'partial-xrefs.delverdb'), target('c'.repeat(64)));
		await service.saveXrefs(partial.projectId, [xref('0x2010', '0x1000')], false);
		const bounded = await service.loadXrefs(partial.projectId, '0x9000', 'to', 16);
		const flags = {
			retained: await service.hasRetainedXrefs(retained.projectId),
			bare: await service.hasRetainedXrefs(bare.projectId),
			partial: await service.hasRetainedXrefs(partial.projectId),
		};
		await service.close(retained.projectId);
		await service.close(bare.projectId);
		await service.close(partial.projectId);

		assert.deepStrictEqual({ answered, unanswerable, bounded, flags }, {
			answered: { xrefs: [], total: 0, truncated: false, complete: true },
			unanswerable: { xrefs: [], total: 0, truncated: false, complete: false },
			bounded: { xrefs: [], total: 0, truncated: false, complete: false },
			flags: { retained: true, bare: false, partial: true },
		});
	});

	test('a bounded xref lookup reports the total before the bound', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'hot-address.delverdb'), target());
		await service.saveXrefs(project.projectId, [
			xref('0x2000', '0x1000'), xref('0x2010', '0x1000'), xref('0x2020', '0x1000'),
			xref('0x2030', '0x1000'), xref('0x2040', '0x1000'),
		], true);

		const bounded = await service.loadXrefs(project.projectId, '0x1000', 'to', 2);
		const whole = await service.loadXrefs(project.projectId, '0x1000', 'to', 5);
		await service.close(project.projectId);

		assert.deepStrictEqual({ bounded, whole }, {
			bounded: {
				xrefs: [xref('0x2000', '0x1000'), xref('0x2010', '0x1000')],
				total: 5, truncated: true, complete: true,
			},
			whole: {
				xrefs: [
					xref('0x2000', '0x1000'), xref('0x2010', '0x1000'), xref('0x2020', '0x1000'),
					xref('0x2030', '0x1000'), xref('0x2040', '0x1000'),
				],
				total: 5, truncated: false, complete: true,
			},
		});
	});

	test('xref addresses above 2^53 are ordered and matched as numbers, not as text', async () => {
		// As text `0x9000` sorts after `0x1ffffffffffffff`, and a lookup written
		// with a leading zero would miss its own row. Neither may happen: an
		// address is a u64, and a truncated or misordered one is a wrong answer
		// rather than a slow one.
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'wide-addresses.delverdb'), target());
		await service.saveXrefs(project.projectId, [
			xref('0x2000000000000000', '0x1ffffffffffffe0'),
			xref('0x1ffffffffffffff', '0x1ffffffffffffe0'),
			xref('0x9000', '0x1ffffffffffffe0'),
		], true);

		const ordered = await service.loadXrefs(project.projectId, '0x1ffffffffffffe0', 'to', 16);
		const padded = await service.loadXrefs(project.projectId, '0x01FFFFFFFFFFFFFF', 'from', 16);
		await service.close(project.projectId);

		assert.deepStrictEqual({ ordered, padded }, {
			ordered: {
				xrefs: [
					xref('0x9000', '0x1ffffffffffffe0'),
					xref('0x1ffffffffffffff', '0x1ffffffffffffe0'),
					xref('0x2000000000000000', '0x1ffffffffffffe0'),
				],
				total: 3, truncated: false, complete: true,
			},
			padded: {
				xrefs: [xref('0x1ffffffffffffff', '0x1ffffffffffffe0')],
				total: 1, truncated: false, complete: true,
			},
		});
	});

	test('malformed cross-references are refused without disturbing the retained table', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'invalid-xrefs.delverdb'), target());
		await service.saveXrefs(project.projectId, [xref('0x2010', '0x1000')], true);

		// A kind and a direction this build has never heard of, widened the way
		// they would arrive over the wire rather than written as literals.
		const foreignKind: string = 'branch';
		const foreignDirection: string = 'sideways';
		const refusals = [
			await rejection(() => service.saveXrefs(project.projectId, [xref('4112', '0x1000')], true)),
			await rejection(() => service.saveXrefs(project.projectId,
				[{ from: '0x2010', to: '0x1000', kind: foreignKind as XrefKindWire }], true)),
			await rejection(() => service.saveXrefs(project.projectId, [xref('0x10000000000000000', '0x1000')], true)),
			await rejection(() => service.loadXrefs(project.projectId, '0xnope', 'to', 16)),
			await rejection(() => service.loadXrefs(project.projectId, '0x1000', foreignDirection as 'to' | 'from', 16)),
			await rejection(() => service.loadXrefs(project.projectId, '0x1000', 'to', 0)),
		];
		const surviving = await service.loadXrefs(project.projectId, '0x1000', 'to', 16);
		await service.close(project.projectId);

		assert.deepStrictEqual({ refusals, surviving }, {
			refusals: [
				'Invalid cross-reference address',
				'Invalid cross-reference kind',
				'Cross-reference address exceeds 64 bits',
				'Invalid cross-reference address',
				'Cross-reference direction must be "to" or "from"',
				'Cross-reference bound must be a positive integer',
			],
			surviving: { xrefs: [xref('0x2010', '0x1000')], total: 1, truncated: false, complete: true },
		});
	});

	test('migrates a schema-v7 project to a table it can retain, without inventing one', async () => {
		const path = join(testRoot, 'legacy-xrefs.delverdb');
		await createSchemaV7Project(path);
		const service = new DelverProjectStoreService();

		const migrated = await service.open(path, HASH_A);
		// A v7 project retained nothing, and the empty new table must not be read
		// as a target with no references.
		const beforeRetention = await service.loadXrefs(migrated.projectId, '0x1000', 'to', 16);
		const beforeFlag = await service.hasRetainedXrefs(migrated.projectId);
		await service.saveXrefs(migrated.projectId, [xref('0x2010', '0x1000')], true);
		await service.close(migrated.projectId);

		const reopened = await service.open(path, HASH_A);
		const snapshot = await service.loadSnapshot(reopened.projectId);
		const afterRetention = await service.loadXrefs(reopened.projectId, '0x1000', 'to', 16);
		await service.close(reopened.projectId);

		assert.deepStrictEqual({
			schemaVersion: snapshot.metadata.schemaVersion,
			functions: snapshot.functions,
			signatures: snapshot.signatures,
			beforeFlag,
			beforeRetention,
			afterRetention,
		}, {
			schemaVersion: 8,
			functions: '{"legacy":true}',
			signatures: [],
			beforeFlag: false,
			beforeRetention: { xrefs: [], total: 0, truncated: false, complete: false },
			afterRetention: { xrefs: [xref('0x2010', '0x1000')], total: 1, truncated: false, complete: true },
		});
	});

	test('migrates a schema-v6 project by keeping each signature as its first record', async () => {
		const path = join(testRoot, 'legacy-signatures.delverdb');
		await createSchemaV6Project(path);
		const service = new DelverProjectStoreService();

		const project = await service.open(path, HASH_A);
		const snapshot = await service.loadSnapshot(project.projectId);
		await service.close(project.projectId);

		assert.deepStrictEqual({
			schemaVersion: snapshot.metadata.schemaVersion,
			signatures: snapshot.signatures,
			records: await readSignatureRecords(path),
		}, {
			schemaVersion: 8,
			signatures: [signature(HASH_A, 'decrypt_config', 'signature-legacy')],
			records: [{
				id: 'signature-legacy', sourceCallId: 'call-signature-1',
				author: 'import:delverdb-v6', supersedes: null, tombstone: 0,
			}],
		});
	});

	test('migrates a schema-v1 project into an initial revision without losing analysis', async () => {
		const path = join(testRoot, 'legacy.delverdb');
		await createSchemaV1Project(path);
		const service = new DelverProjectStoreService();

		const project = await service.open(path, HASH_A);
		const snapshot = await service.loadSnapshot(project.projectId);
		const revisions = await service.listRevisions(project.projectId);
		await service.close(project.projectId);

		assert.deepStrictEqual({
			schemaVersion: snapshot.metadata.schemaVersion,
			currentRevisionId: snapshot.metadata.currentRevisionId,
			functions: snapshot.functions,
			decompiledFunctions: snapshot.decompiledFunctions,
			interpretations: snapshot.interpretations,
			findings: snapshot.findings,
			findingDecisions: snapshot.findingDecisions,
			toolCalls: snapshot.toolCalls,
			signatures: snapshot.signatures,
			revisions: revisions.map(revision => ({ ...revision, createdAt: 0 })),
		}, {
			schemaVersion: 8,
			currentRevisionId: HASH_A,
			functions: '{"legacy":true}',
			decompiledFunctions: [{ backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x1000', serialized: '{"text":"legacy"}' }],
			interpretations: [edit()],
			findings: [],
			findingDecisions: [],
			toolCalls: [],
			signatures: [],
			revisions: [{ ...target(), revisionId: HASH_A, createdAt: 0 }],
		});
	});
});

/** The message one call rejects with, so a batch of refusals reads as one assertion. */
async function rejection(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
	} catch (error) {
		return (error as Error).message;
	}
	return 'resolved';
}

/** The append-only signature records exactly as they sit on disk. */
async function readSignatureRecords(path: string): Promise<readonly Record<string, unknown>[]> {
	const db = await openDatabase(path);
	const rows = await new Promise<Record<string, unknown>[]>((resolvePromise, reject) =>
		db.all('SELECT id, payload, author_kind, author_id, supersedes, tombstone FROM named_signatures ORDER BY seq', [],
			(error: Error | null, result: Record<string, unknown>[]) => error ? reject(error) : resolvePromise(result)));
	await new Promise<void>((resolvePromise, reject) => db.close(error => error ? reject(error) : resolvePromise()));
	return rows.map(row => ({
		id: row.id,
		sourceCallId: typeof row.payload === 'string'
			? (JSON.parse(row.payload) as IDelverNamedSignatureWire).sourceCallId
			: undefined,
		author: `${row.author_kind}:${row.author_id}`,
		supersedes: row.supersedes,
		tombstone: row.tombstone,
	}));
}

async function openDatabase(path: string): Promise<Database> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	return new Promise<Database>((resolvePromise, reject) => {
		const opened = new sqlite3.Database(path, (error: Error | null) => error ? reject(error) : resolvePromise(opened));
	});
}

/** Every table a v6 and a v7 project share, so the fixtures differ only where the migration does. */
const LEGACY_SHARED_SCHEMA = `
	CREATE TABLE project_metadata (
		id INTEGER PRIMARY KEY CHECK (id = 1), content_hash TEXT NOT NULL, display_name TEXT NOT NULL,
		source_path TEXT, byte_length INTEGER, current_revision_id TEXT NOT NULL,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	);
	CREATE TABLE revisions (
		revision_id TEXT PRIMARY KEY NOT NULL, content_hash TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
		source_path TEXT, byte_length INTEGER, created_at INTEGER NOT NULL
	);
	CREATE TABLE analysis_snapshots (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), kind TEXT NOT NULL,
		payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (revision_id, kind)
	);
	CREATE TABLE decompiled_functions (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), backend_id TEXT NOT NULL,
		backend_version TEXT NOT NULL, function_rva TEXT NOT NULL, payload TEXT NOT NULL,
		updated_at INTEGER NOT NULL, PRIMARY KEY (revision_id, backend_id, backend_version, function_rva)
	);
	CREATE TABLE interpretations (
		id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), payload TEXT NOT NULL,
		created_at INTEGER NOT NULL, UNIQUE (revision_id, seq)
	);
	CREATE TABLE findings (
		id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (revision_id, id)
	);
	CREATE TABLE finding_decisions (
		id TEXT PRIMARY KEY NOT NULL, finding_id TEXT NOT NULL, revision_id TEXT NOT NULL,
		payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (revision_id, finding_id),
		FOREIGN KEY (revision_id, finding_id) REFERENCES findings(revision_id, id)
	);
	CREATE TABLE tool_calls (
		call_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (revision_id, call_id)
	);
	CREATE TABLE function_migrations (
		source_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), source_function_rva TEXT NOT NULL,
		target_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), target_function_rva TEXT NOT NULL,
		method TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, provenance TEXT,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (source_revision_id, source_function_rva, target_revision_id, target_function_rva)
	);
	INSERT INTO project_metadata VALUES (1, '${HASH_A}', 'sample.exe', 'C:\\samples\\sample.exe', 4096, '${HASH_A}', 100, 200);
	INSERT INTO revisions VALUES ('${HASH_A}', '${HASH_A}', 'sample.exe', 'C:\\samples\\sample.exe', 4096, 100);
`;

async function execSchema(path: string, sql: string): Promise<void> {
	const db = await openDatabase(path);
	await new Promise<void>((resolvePromise, reject) => db.exec(sql, error => error ? reject(error) : resolvePromise()));
	await new Promise<void>((resolvePromise, reject) => db.close(error => error ? reject(error) : resolvePromise()));
}

async function createSchemaV6Project(path: string): Promise<void> {
	const legacy = escapeSql(JSON.stringify(signature(HASH_A, 'decrypt_config', 'signature-legacy')));
	await execSchema(path, `
		${LEGACY_SHARED_SCHEMA}
		CREATE TABLE named_signatures (
			id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
			revision_id TEXT NOT NULL REFERENCES revisions(revision_id), payload TEXT NOT NULL,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (revision_id, name_key)
		);
		INSERT INTO named_signatures VALUES ('signature-legacy', 'decrypt_config', 'decrypt_config', '${HASH_A}', '${legacy}', 100, 200);
		PRAGMA user_version = 6;
	`);
}

async function createSchemaV7Project(path: string): Promise<void> {
	await execSchema(path, `
		${LEGACY_SHARED_SCHEMA}
		CREATE TABLE named_signatures (
			seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
			revision_id TEXT NOT NULL REFERENCES revisions(revision_id), name_key TEXT, payload TEXT,
			author_kind TEXT NOT NULL, author_id TEXT NOT NULL, supersedes INTEGER,
			tombstone INTEGER NOT NULL, recorded_at INTEGER NOT NULL
		);
		CREATE INDEX named_signatures_current ON named_signatures (revision_id, id, seq);
		INSERT INTO analysis_snapshots VALUES ('${HASH_A}', 'functions', '{"legacy":true}', 200);
		PRAGMA user_version = 7;
	`);
}

async function createSchemaV1Project(path: string): Promise<void> {
	const db = await openDatabase(path);
	await new Promise<void>((resolvePromise, reject) => db.exec(`
		CREATE TABLE project_metadata (
			id INTEGER PRIMARY KEY CHECK (id = 1), content_hash TEXT NOT NULL, display_name TEXT NOT NULL,
			source_path TEXT, byte_length INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE analysis_snapshots (kind TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE decompiled_functions (
			backend_id TEXT NOT NULL, backend_version TEXT NOT NULL, function_rva TEXT NOT NULL,
			payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (backend_id, backend_version, function_rva)
		);
		CREATE TABLE interpretations (
			id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, created_at INTEGER NOT NULL
		);
		INSERT INTO project_metadata VALUES (1, '${HASH_A}', 'sample.exe', 'C:\\samples\\sample.exe', 4096, 100, 200);
		INSERT INTO analysis_snapshots VALUES ('functions', '{"legacy":true}', 200);
		INSERT INTO decompiled_functions VALUES ('ghidra', '12.1', '0x1000', '{"text":"legacy"}', 200);
		INSERT INTO interpretations (seq, payload, created_at) VALUES (1, '${escapeSql(JSON.stringify(edit()))}', 200);
		PRAGMA user_version = 1;
	`, error => error ? reject(error) : resolvePromise()));
	await new Promise<void>((resolvePromise, reject) => db.close(error => error ? reject(error) : resolvePromise()));
}

function escapeSql(value: string): string {
	const quote = String.fromCharCode(39);
	return value.replaceAll(quote, quote.repeat(2));
}
