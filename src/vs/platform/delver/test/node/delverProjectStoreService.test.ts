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
import { IInterpretationEditWire } from '../../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../../common/interpretation.js';
import { DelverProjectStoreService } from '../../node/delverProjectStoreService.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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
			containsPeHeader: databaseBytes.includes(Buffer.from('MZThis must not be persisted')),
		}, {
			metadata: { ...target(), schemaVersion: 2, currentRevisionId: HASH_A, createdAt: 0, updatedAt: 0 },
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

		assert.strictEqual(await service.copyInterpretations(first.projectId, second.projectId), 1);
		assert.deepStrictEqual((await service.loadSnapshot(second.projectId)).interpretations, [edit()]);
		await assert.rejects(() => service.copyInterpretations(first.projectId, different.projectId), /different target bytes/);
		await assert.rejects(() => service.appendInterpretations(different.projectId, [edit()]), /different target bytes/);

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

	test('retains independent snapshots for every target revision', async () => {
		const service = new DelverProjectStoreService();
		const project = await service.create(join(testRoot, 'revisions.delverdb'), target());
		await service.saveSnapshot(project.projectId, { functions: '{"build":"old"}' });
		await service.appendInterpretations(project.projectId, [edit(HASH_A)]);
		const next = await service.addRevision(project.projectId, {
			...target(HASH_B), displayName: 'sample-2.exe', sourcePath: 'C:\\samples\\sample-2.exe', byteLength: 8192,
		}, { functions: '{"build":"new"}' });
		await service.appendInterpretations(project.projectId, [edit(HASH_B)]);

		const revisions = await service.listRevisions(project.projectId);
		const oldSnapshot = await service.loadSnapshot(project.projectId, HASH_A);
		const newSnapshot = await service.loadSnapshot(project.projectId, next.revisionId);
		await service.close(project.projectId);

		assert.deepStrictEqual({
			revisions: revisions.map(revision => ({ ...revision, createdAt: 0 })),
			old: { hash: oldSnapshot.metadata.contentHash, functions: oldSnapshot.functions },
			current: { hash: newSnapshot.metadata.contentHash, functions: newSnapshot.functions },
			interpretationHashes: [oldSnapshot.interpretations[0]?.anchor.contentHash, newSnapshot.interpretations[0]?.anchor.contentHash],
		}, {
			revisions: [
				{ ...target(), revisionId: HASH_A, createdAt: 0 },
				{ ...target(HASH_B), displayName: 'sample-2.exe', sourcePath: 'C:\\samples\\sample-2.exe', byteLength: 8192, revisionId: HASH_B, createdAt: 0 },
			],
			old: { hash: HASH_A, functions: '{"build":"old"}' },
			current: { hash: HASH_B, functions: '{"build":"new"}' },
			interpretationHashes: [HASH_A, HASH_B],
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
			method: 'manual', confidence: 1, status: 'accepted', provenance: '{"author":"analyst"}',
		}]);
		await service.close(project.projectId);

		const reopened = await service.open(path);
		const mappings = await service.loadFunctionMigrationMappings(reopened.projectId, HASH_A, HASH_B);
		await service.close(reopened.projectId);
		assert.deepStrictEqual(mappings, [{
			sourceRevisionId: HASH_A, sourceRva: '0x1000', targetRevisionId: HASH_B, targetRva: '0x2000',
			method: 'manual', confidence: 1, status: 'accepted', provenance: '{"author":"analyst"}',
		}]);
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
			revisions: revisions.map(revision => ({ ...revision, createdAt: 0 })),
		}, {
			schemaVersion: 2,
			currentRevisionId: HASH_A,
			functions: '{"legacy":true}',
			decompiledFunctions: [{ backendId: 'ghidra', backendVersion: '12.1', functionRva: '0x1000', serialized: '{"text":"legacy"}' }],
			interpretations: [edit()],
			revisions: [{ ...target(), revisionId: HASH_A, createdAt: 0 }],
		});
	});
});

async function createSchemaV1Project(path: string): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const db = await new Promise<Database>((resolvePromise, reject) => {
		const opened = new sqlite3.Database(path, (error: Error | null) => error ? reject(error) : resolvePromise(opened));
	});
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
		INSERT INTO interpretations (seq, payload, created_at) VALUES (1, '${JSON.stringify(edit()).replaceAll("'", "''")}', 200);
		PRAGMA user_version = 1;
	`, error => error ? reject(error) : resolvePromise()));
	await new Promise<void>((resolvePromise, reject) => db.close(error => error ? reject(error) : resolvePromise()));
}
