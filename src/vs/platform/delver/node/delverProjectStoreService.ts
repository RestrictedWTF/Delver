/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database, RunResult } from '@vscode/sqlite3';
import { promises } from 'fs';
import { Sequencer } from '../../../base/common/async.js';
import { dirname, extname, isAbsolute, resolve } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import {
	DelverFunctionMigrationMethod,
	DelverFunctionMigrationStatus,
	IDelverFunctionMigrationMapping,
	IDelverProjectHandle,
	IDelverProjectMetadata,
	IDelverProjectRevision,
	IDelverProjectSnapshot,
	IDelverProjectSnapshotUpdate,
	IDelverProjectStoreService,
	IDelverProjectTargetIdentity,
} from '../common/delverProjectStoreService.js';
import { IInterpretationEditWire, isContentHash } from '../common/delverInterpretationStoreService.js';

const PROJECT_SCHEMA_VERSION = 2;
const WIRE_RVA = /^0x[0-9a-fA-F]+$/;
const SNAPSHOT_KINDS = ['imageInfo', 'functions', 'imports', 'exports', 'strings'] as const;
type SnapshotKind = typeof SNAPSHOT_KINDS[number];

const PROJECT_SCHEMA = `
	CREATE TABLE project_metadata (
		id            INTEGER PRIMARY KEY CHECK (id = 1),
		content_hash  TEXT NOT NULL,
		display_name  TEXT NOT NULL,
		source_path   TEXT,
		byte_length   INTEGER,
		current_revision_id TEXT NOT NULL,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
	CREATE TABLE revisions (
		revision_id  TEXT PRIMARY KEY NOT NULL,
		content_hash TEXT UNIQUE NOT NULL,
		display_name TEXT NOT NULL,
		source_path  TEXT,
		byte_length  INTEGER,
		created_at   INTEGER NOT NULL
	);
	CREATE TABLE analysis_snapshots (
		revision_id   TEXT NOT NULL REFERENCES revisions(revision_id),
		kind          TEXT NOT NULL,
		payload       TEXT NOT NULL,
		updated_at    INTEGER NOT NULL,
		PRIMARY KEY (revision_id, kind)
	);
	CREATE TABLE decompiled_functions (
		revision_id     TEXT NOT NULL REFERENCES revisions(revision_id),
		backend_id      TEXT NOT NULL,
		backend_version TEXT NOT NULL,
		function_rva    TEXT NOT NULL,
		payload         TEXT NOT NULL,
		updated_at      INTEGER NOT NULL,
		PRIMARY KEY (revision_id, backend_id, backend_version, function_rva)
	);
	CREATE TABLE interpretations (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		seq         INTEGER NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload     TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		UNIQUE (revision_id, seq)
	);
	CREATE TABLE function_migrations (
		source_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		source_function_rva TEXT NOT NULL,
		target_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		target_function_rva TEXT NOT NULL,
		method TEXT NOT NULL,
		confidence REAL NOT NULL,
		status TEXT NOT NULL,
		provenance TEXT,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (source_revision_id, source_function_rva, target_revision_id, target_function_rva)
	);
	PRAGMA user_version = ${PROJECT_SCHEMA_VERSION};
`;

const MIGRATE_V1_TO_V2 = `
	CREATE TABLE revisions (
		revision_id TEXT PRIMARY KEY NOT NULL,
		content_hash TEXT UNIQUE NOT NULL,
		display_name TEXT NOT NULL,
		source_path TEXT,
		byte_length INTEGER,
		created_at INTEGER NOT NULL
	);
	INSERT INTO revisions (revision_id, content_hash, display_name, source_path, byte_length, created_at)
		SELECT content_hash, content_hash, display_name, source_path, byte_length, created_at FROM project_metadata WHERE id = 1;
	ALTER TABLE project_metadata ADD COLUMN current_revision_id TEXT;
	UPDATE project_metadata SET current_revision_id = content_hash WHERE id = 1;
	CREATE TABLE analysis_snapshots_v2 (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), kind TEXT NOT NULL,
		payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (revision_id, kind)
	);
	INSERT INTO analysis_snapshots_v2 SELECT (SELECT content_hash FROM project_metadata WHERE id = 1), kind, payload, updated_at FROM analysis_snapshots;
	DROP TABLE analysis_snapshots;
	ALTER TABLE analysis_snapshots_v2 RENAME TO analysis_snapshots;
	CREATE TABLE decompiled_functions_v2 (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), backend_id TEXT NOT NULL,
		backend_version TEXT NOT NULL, function_rva TEXT NOT NULL, payload TEXT NOT NULL,
		updated_at INTEGER NOT NULL, PRIMARY KEY (revision_id, backend_id, backend_version, function_rva)
	);
	INSERT INTO decompiled_functions_v2 SELECT (SELECT content_hash FROM project_metadata WHERE id = 1),
		backend_id, backend_version, function_rva, payload, updated_at FROM decompiled_functions;
	DROP TABLE decompiled_functions;
	ALTER TABLE decompiled_functions_v2 RENAME TO decompiled_functions;
	CREATE TABLE interpretations_v2 (
		id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), payload TEXT NOT NULL,
		created_at INTEGER NOT NULL, UNIQUE (revision_id, seq)
	);
	INSERT INTO interpretations_v2 (id, seq, revision_id, payload, created_at)
		SELECT id, seq, (SELECT content_hash FROM project_metadata WHERE id = 1), payload, created_at FROM interpretations;
	DROP TABLE interpretations;
	ALTER TABLE interpretations_v2 RENAME TO interpretations;
	CREATE TABLE function_migrations (
		source_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), source_function_rva TEXT NOT NULL,
		target_revision_id TEXT NOT NULL REFERENCES revisions(revision_id), target_function_rva TEXT NOT NULL,
		method TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, provenance TEXT, updated_at INTEGER NOT NULL,
		PRIMARY KEY (source_revision_id, source_function_rva, target_revision_id, target_function_rva)
	);
	PRAGMA user_version = ${PROJECT_SCHEMA_VERSION};
`;

interface IOpenProject {
	readonly path: string;
	readonly db: Database;
	metadata: IDelverProjectMetadata;
}

/** Shared-process implementation of the portable `.delverdb` project format. */
export class DelverProjectStoreService implements IDelverProjectStoreService {
	readonly _serviceBrand: undefined;

	private readonly projects = new Map<string, IOpenProject>();
	private readonly sequencer = new Sequencer();

	create(path: string, target: IDelverProjectTargetIdentity): Promise<IDelverProjectHandle> {
		return this.sequencer.queue(async () => {
			validateProjectPath(path);
			validateTarget(target);
			const normalizedPath = resolve(path);
			if (this.findByPath(normalizedPath)) {
				throw new Error('Delver project is already open');
			}
			await promises.mkdir(dirname(normalizedPath), { recursive: true });
			try {
				await promises.access(normalizedPath);
				throw new Error('Delver project already exists');
			} catch (error) {
				if (!isFileNotFound(error)) {
					throw error;
				}
			}

			const db = await dbOpen(normalizedPath);
			try {
				await dbExec(db, 'PRAGMA foreign_keys = ON');
				await dbExec(db, PROJECT_SCHEMA);
				const now = Date.now();
				await transaction(db, async () => {
					await insertRevision(db, target, now);
					await dbRun(db, `INSERT INTO project_metadata
						(id, content_hash, display_name, source_path, byte_length, current_revision_id, created_at, updated_at)
						VALUES (1, ?, ?, ?, ?, ?, ?, ?)`, [
						target.contentHash, target.displayName, target.sourcePath ?? null,
						target.byteLength ?? null, target.contentHash, now, now,
					]);
				});
				const metadata: IDelverProjectMetadata = {
					...target, schemaVersion: PROJECT_SCHEMA_VERSION, currentRevisionId: target.contentHash, createdAt: now, updatedAt: now
				};
				return this.retain(normalizedPath, db, metadata);
			} catch (error) {
				await dbClose(db);
				throw error;
			}
		});
	}

	open(path: string, expectedContentHash?: string): Promise<IDelverProjectHandle> {
		return this.sequencer.queue(async () => {
			validateProjectPath(path);
			if (expectedContentHash !== undefined && !isContentHash(expectedContentHash)) {
				throw new Error('Expected content hash must be a lowercase SHA-256 value');
			}
			const normalizedPath = resolve(path);
			if (this.findByPath(normalizedPath)) {
				throw new Error('Delver project is already open');
			}
			await promises.access(normalizedPath);
			const db = await dbOpen(normalizedPath);
			try {
				await dbExec(db, 'PRAGMA foreign_keys = ON');
				let version = await readSchemaVersion(db);
				if (version === 1) {
					await transaction(db, () => dbExec(db, MIGRATE_V1_TO_V2));
					version = PROJECT_SCHEMA_VERSION;
				}
				if (version !== PROJECT_SCHEMA_VERSION) {
					throw new Error(`Unsupported Delver project schema version ${version}`);
				}
				let metadata = await readMetadata(db, version);
				if (expectedContentHash !== undefined && metadata.contentHash !== expectedContentHash) {
					const revision = await findRevisionByContentHash(db, expectedContentHash);
					if (!revision) {
						throw new Error('Delver project belongs to different target bytes');
					}
					const now = Date.now();
					await setCurrentRevision(db, revision, now);
					metadata = metadataForRevision(metadata, revision, now);
				}
				return this.retain(normalizedPath, db, metadata);
			} catch (error) {
				await dbClose(db);
				throw error;
			}
		});
	}

	addRevision(projectId: string, target: IDelverProjectTargetIdentity, snapshot?: IDelverProjectSnapshotUpdate): Promise<IDelverProjectRevision> {
		return this.sequencer.queue(async () => {
			validateTarget(target);
			if (snapshot !== undefined) {
				validateSnapshot(snapshot);
			}
			const project = this.getProject(projectId);
			const existing = await findRevisionByContentHash(project.db, target.contentHash);
			const now = Date.now();
			const revision = existing ?? { ...target, revisionId: target.contentHash, createdAt: now };
			await transaction(project.db, async () => {
				if (!existing) {
					await insertRevision(project.db, target, now);
				}
				if (snapshot !== undefined) {
					await persistSnapshot(project.db, revision.revisionId, snapshot, now);
				}
				await setCurrentRevision(project.db, revision, now);
			});
			project.metadata = metadataForRevision(project.metadata, revision, now);
			return revision;
		});
	}

	listRevisions(projectId: string): Promise<readonly IDelverProjectRevision[]> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			return (await dbAll(project.db, `SELECT revision_id, content_hash, display_name, source_path, byte_length, created_at
				FROM revisions ORDER BY created_at, revision_id`, [])).map(revisionFromRow);
		});
	}

	saveSnapshot(projectId: string, snapshot: IDelverProjectSnapshotUpdate, revisionId?: string): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revision = await requireRevision(project.db, revisionId ?? project.metadata.currentRevisionId);
			validateSnapshot(snapshot);
			const now = Date.now();
			await transaction(project.db, async () => {
				await persistSnapshot(project.db, revision.revisionId, snapshot, now);
				await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
			});
			project.metadata = { ...project.metadata, updatedAt: now };
		});
	}

	loadSnapshot(projectId: string, revisionId?: string): Promise<IDelverProjectSnapshot> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revision = await requireRevision(project.db, revisionId ?? project.metadata.currentRevisionId);
			const snapshotRows = await dbAll(project.db, 'SELECT kind, payload FROM analysis_snapshots WHERE revision_id = ?', [revision.revisionId]);
			const snapshots: Partial<Record<SnapshotKind, string>> = {};
			for (const row of snapshotRows) {
				if (isSnapshotKind(row.kind)) {
					snapshots[row.kind] = requireString(row.payload, 'snapshot payload');
				}
			}
			const decompiledFunctions = (await dbAll(project.db,
				`SELECT backend_id, backend_version, function_rva, payload FROM decompiled_functions
				 WHERE revision_id = ? ORDER BY backend_id, backend_version, function_rva`, [revision.revisionId])).map(row => ({
				backendId: requireString(row.backend_id, 'backend id'),
				backendVersion: requireString(row.backend_version, 'backend version'),
				functionRva: requireString(row.function_rva, 'function RVA'),
				serialized: requireString(row.payload, 'decompilation payload'),
			}));
			const interpretations = (await dbAll(project.db, 'SELECT payload FROM interpretations WHERE revision_id = ? ORDER BY seq', [revision.revisionId]))
				.map(row => JSON.parse(requireString(row.payload, 'interpretation payload')) as IInterpretationEditWire);
			return { metadata: metadataForRevision(project.metadata, revision, project.metadata.updatedAt), ...snapshots, decompiledFunctions, interpretations };
		});
	}

	appendInterpretations(projectId: string, edits: readonly IInterpretationEditWire[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revisions = new Map<string, IDelverProjectRevision>();
			for (const edit of edits) {
				const revision = await findRevisionByContentHash(project.db, edit.anchor?.contentHash);
				if (!revision) {
					throw new Error('Interpretation belongs to different target bytes');
				}
				revisions.set(edit.anchor.contentHash, revision);
			}
			const now = Date.now();
			await transaction(project.db, async () => {
				for (const edit of edits) {
					await dbRun(project.db, 'INSERT OR IGNORE INTO interpretations (seq, revision_id, payload, created_at) VALUES (?, ?, ?, ?)',
						[edit.seq, revisions.get(edit.anchor.contentHash)!.revisionId, JSON.stringify(edit), now]);
				}
				if (edits.length > 0) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (edits.length > 0) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	copyInterpretations(sourceProjectId: string, destinationProjectId: string): Promise<number> {
		return this.sequencer.queue(async () => {
			const source = this.getProject(sourceProjectId);
			const destination = this.getProject(destinationProjectId);
			const rows = await dbAll(source.db, `SELECT i.seq, i.payload, r.content_hash FROM interpretations i
				JOIN revisions r ON r.revision_id = i.revision_id ORDER BY i.seq`, []);
			const destinationRevisions = new Map<string, IDelverProjectRevision>();
			for (const row of rows) {
				const contentHash = requireString(row.content_hash, 'revision content hash');
				const revision = await findRevisionByContentHash(destination.db, contentHash);
				if (!revision) {
					throw new Error('Cannot copy interpretations between different target bytes');
				}
				destinationRevisions.set(contentHash, revision);
			}
			const now = Date.now();
			let copied = 0;
			await transaction(destination.db, async () => {
				for (const row of rows) {
					const revision = destinationRevisions.get(requireString(row.content_hash, 'revision content hash'))!;
					copied += await dbRun(destination.db, 'INSERT OR IGNORE INTO interpretations (seq, revision_id, payload, created_at) VALUES (?, ?, ?, ?)',
						[requirePositiveInteger(row.seq, 'interpretation sequence'), revision.revisionId, requireString(row.payload, 'interpretation payload'), now]);
				}
				if (rows.length > 0) {
					await dbRun(destination.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (rows.length > 0) {
				destination.metadata = { ...destination.metadata, updatedAt: now };
			}
			return copied;
		});
	}

	storeFunctionMigrationMappings(projectId: string, mappings: readonly IDelverFunctionMigrationMapping[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			for (const mapping of mappings) {
				validateFunctionMigrationMapping(mapping);
				await requireRevision(project.db, mapping.sourceRevisionId);
				await requireRevision(project.db, mapping.targetRevisionId);
			}
			const now = Date.now();
			await transaction(project.db, async () => {
				for (const mapping of mappings) {
					await dbRun(project.db, `INSERT INTO function_migrations
						(source_revision_id, source_function_rva, target_revision_id, target_function_rva, method, confidence, status, provenance, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(source_revision_id, source_function_rva, target_revision_id, target_function_rva)
						DO UPDATE SET method = excluded.method, confidence = excluded.confidence,
							status = excluded.status, provenance = excluded.provenance, updated_at = excluded.updated_at`, [
						mapping.sourceRevisionId, normalizeRva(mapping.sourceRva),
						mapping.targetRevisionId, normalizeRva(mapping.targetRva),
						mapping.method, mapping.confidence, mapping.status, mapping.provenance ?? null, now,
					]);
				}
				if (mappings.length > 0) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (mappings.length > 0) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	loadFunctionMigrationMappings(projectId: string, sourceRevisionId: string, targetRevisionId: string): Promise<readonly IDelverFunctionMigrationMapping[]> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			await requireRevision(project.db, sourceRevisionId);
			await requireRevision(project.db, targetRevisionId);
			return (await dbAll(project.db, `SELECT source_revision_id, source_function_rva, target_revision_id,
				target_function_rva, method, confidence, status, provenance FROM function_migrations
				WHERE source_revision_id = ? AND target_revision_id = ? ORDER BY source_function_rva, target_function_rva`,
			[sourceRevisionId, targetRevisionId])).map(functionMigrationMappingFromRow);
		});
	}

	close(projectId: string): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			this.projects.delete(projectId);
			await dbClose(project.db);
		});
	}

	private retain(path: string, db: Database, metadata: IDelverProjectMetadata): IDelverProjectHandle {
		const projectId = generateUuid();
		this.projects.set(projectId, { path, db, metadata });
		return { projectId, path, metadata };
	}

	private getProject(projectId: string): IOpenProject {
		const project = this.projects.get(projectId);
		if (!project) {
			throw new Error('Delver project is not open');
		}
		return project;
	}

	private findByPath(path: string): IOpenProject | undefined {
		return [...this.projects.values()].find(project => project.path === path);
	}
}

function validateProjectPath(path: string): void {
	if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== '.delverdb') {
		throw new Error('Delver project path must be an absolute .delverdb path');
	}
}

function validateTarget(target: IDelverProjectTargetIdentity): void {
	if (!isContentHash(target.contentHash) || !target.displayName
		|| (target.sourcePath !== undefined && !isAbsolute(target.sourcePath))
		|| (target.byteLength !== undefined && (!Number.isSafeInteger(target.byteLength) || target.byteLength < 0))) {
		throw new Error('Invalid Delver project target identity');
	}
}

function validateSnapshot(snapshot: IDelverProjectSnapshotUpdate): void {
	for (const kind of SNAPSHOT_KINDS) {
		const payload = snapshot[kind];
		if (payload !== undefined) {
			validateJson(payload, `${kind} payload`);
		}
	}
	for (const result of snapshot.decompiledFunctions ?? []) {
		if (!result.backendId || !result.backendVersion || !WIRE_RVA.test(result.functionRva)) {
			throw new Error('Invalid decompiled function identity');
		}
		validateJson(result.serialized, 'decompiled function payload');
	}
}

async function persistSnapshot(db: Database, revisionId: string, snapshot: IDelverProjectSnapshotUpdate, updatedAt: number): Promise<void> {
	for (const kind of SNAPSHOT_KINDS) {
		const payload = snapshot[kind];
		if (payload !== undefined) {
			await dbRun(db, `INSERT INTO analysis_snapshots (revision_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(revision_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
			[revisionId, kind, payload, updatedAt]);
		}
	}
	if (snapshot.decompiledFunctions !== undefined) {
		if (snapshot.decompiledFunctions.length === 0) {
			await dbRun(db, 'DELETE FROM decompiled_functions WHERE revision_id = ?', [revisionId]);
		} else {
			for (const result of snapshot.decompiledFunctions) {
				await dbRun(db, `INSERT INTO decompiled_functions
					(revision_id, backend_id, backend_version, function_rva, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(revision_id, backend_id, backend_version, function_rva) DO UPDATE
					SET payload = excluded.payload, updated_at = excluded.updated_at`,
				[revisionId, result.backendId, result.backendVersion, normalizeRva(result.functionRva), result.serialized, updatedAt]);
			}
		}
	}
}

function validateFunctionMigrationMapping(mapping: IDelverFunctionMigrationMapping): void {
	if (!mapping.sourceRevisionId || !mapping.targetRevisionId
		|| !WIRE_RVA.test(mapping.sourceRva) || !WIRE_RVA.test(mapping.targetRva)
		|| !isFunctionMigrationMethod(mapping.method) || !isFunctionMigrationStatus(mapping.status)
		|| !Number.isFinite(mapping.confidence) || mapping.confidence < 0 || mapping.confidence > 1
		|| (mapping.provenance !== undefined && mapping.provenance.length === 0)) {
		throw new Error('Invalid function migration mapping');
	}
}

function isFunctionMigrationMethod(value: unknown): value is DelverFunctionMigrationMethod {
	return value === 'exact' || value === 'symbol' || value === 'structural' || value === 'manual';
}

function isFunctionMigrationStatus(value: unknown): value is DelverFunctionMigrationStatus {
	return value === 'proposed' || value === 'accepted' || value === 'rejected';
}

function validateJson(value: string, label: string): void {
	try {
		JSON.parse(value);
	} catch {
		throw new Error(`Invalid JSON in ${label}`);
	}
}

function normalizeRva(rva: string): string {
	return `0x${BigInt(rva).toString(16)}`;
}

function isSnapshotKind(value: unknown): value is SnapshotKind {
	return typeof value === 'string' && (SNAPSHOT_KINDS as readonly string[]).includes(value);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Invalid ${label} in Delver project`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`Invalid ${label} in Delver project`);
	}
	return value;
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readSchemaVersion(db: Database): Promise<number> {
	const row = await dbGet(db, 'PRAGMA user_version', []);
	return typeof row?.user_version === 'number' ? row.user_version : 0;
}

async function readMetadata(db: Database, schemaVersion: number): Promise<IDelverProjectMetadata> {
	const row = await dbGet(db, `SELECT content_hash, display_name, source_path, byte_length, current_revision_id, created_at, updated_at
		FROM project_metadata WHERE id = 1`, []);
	if (!row) {
		throw new Error('Delver project has no target metadata');
	}
	const metadata: IDelverProjectMetadata = {
		contentHash: requireString(row.content_hash, 'content hash'),
		displayName: requireString(row.display_name, 'display name'),
		schemaVersion,
		currentRevisionId: requireString(row.current_revision_id, 'current revision id'),
		createdAt: requireNumber(row.created_at, 'creation time'),
		updatedAt: requireNumber(row.updated_at, 'update time'),
		...(typeof row.source_path === 'string' ? { sourcePath: row.source_path } : {}),
		...(typeof row.byte_length === 'number' ? { byteLength: row.byte_length } : {}),
	};
	validateTarget(metadata);
	return metadata;
}

async function insertRevision(db: Database, target: IDelverProjectTargetIdentity, createdAt: number): Promise<void> {
	await dbRun(db, `INSERT INTO revisions
		(revision_id, content_hash, display_name, source_path, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
		target.contentHash, target.contentHash, target.displayName, target.sourcePath ?? null, target.byteLength ?? null, createdAt,
	]);
}

async function setCurrentRevision(db: Database, revision: IDelverProjectRevision, updatedAt: number): Promise<void> {
	await dbRun(db, `UPDATE project_metadata SET content_hash = ?, display_name = ?, source_path = ?,
		byte_length = ?, current_revision_id = ?, updated_at = ? WHERE id = 1`, [
		revision.contentHash, revision.displayName, revision.sourcePath ?? null, revision.byteLength ?? null,
		revision.revisionId, updatedAt,
	]);
}

function metadataForRevision(metadata: IDelverProjectMetadata, revision: IDelverProjectRevision, updatedAt: number): IDelverProjectMetadata {
	return {
		contentHash: revision.contentHash,
		displayName: revision.displayName,
		...(revision.sourcePath !== undefined ? { sourcePath: revision.sourcePath } : {}),
		...(revision.byteLength !== undefined ? { byteLength: revision.byteLength } : {}),
		schemaVersion: PROJECT_SCHEMA_VERSION,
		currentRevisionId: revision.revisionId,
		createdAt: metadata.createdAt,
		updatedAt,
	};
}

async function findRevisionByContentHash(db: Database, contentHash: string | undefined): Promise<IDelverProjectRevision | undefined> {
	if (!contentHash) {
		return undefined;
	}
	const row = await dbGet(db, `SELECT revision_id, content_hash, display_name, source_path, byte_length, created_at
		FROM revisions WHERE content_hash = ?`, [contentHash]);
	return row ? revisionFromRow(row) : undefined;
}

async function requireRevision(db: Database, revisionId: string): Promise<IDelverProjectRevision> {
	const row = await dbGet(db, `SELECT revision_id, content_hash, display_name, source_path, byte_length, created_at
		FROM revisions WHERE revision_id = ?`, [revisionId]);
	if (!row) {
		throw new Error('Delver project revision does not exist');
	}
	return revisionFromRow(row);
}

function revisionFromRow(row: Record<string, unknown>): IDelverProjectRevision {
	const revision: IDelverProjectRevision = {
		revisionId: requireString(row.revision_id, 'revision id'),
		contentHash: requireString(row.content_hash, 'content hash'),
		displayName: requireString(row.display_name, 'display name'),
		createdAt: requireNumber(row.created_at, 'revision creation time'),
		...(typeof row.source_path === 'string' ? { sourcePath: row.source_path } : {}),
		...(typeof row.byte_length === 'number' ? { byteLength: row.byte_length } : {}),
	};
	validateTarget(revision);
	return revision;
}

function functionMigrationMappingFromRow(row: Record<string, unknown>): IDelverFunctionMigrationMapping {
	const mapping: IDelverFunctionMigrationMapping = {
		sourceRevisionId: requireString(row.source_revision_id, 'source revision id'),
		sourceRva: requireString(row.source_function_rva, 'source function RVA'),
		targetRevisionId: requireString(row.target_revision_id, 'target revision id'),
		targetRva: requireString(row.target_function_rva, 'target function RVA'),
		method: requireString(row.method, 'migration method') as DelverFunctionMigrationMethod,
		confidence: requireNumber(row.confidence, 'migration confidence'),
		status: requireString(row.status, 'migration status') as DelverFunctionMigrationStatus,
		...(typeof row.provenance === 'string' ? { provenance: row.provenance } : {}),
	};
	validateFunctionMigrationMapping(mapping);
	return mapping;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== 'number') {
		throw new Error(`Invalid ${label} in Delver project`);
	}
	return value;
}

async function transaction(db: Database, operation: () => Promise<void>): Promise<void> {
	await dbExec(db, 'BEGIN IMMEDIATE');
	try {
		await operation();
		await dbExec(db, 'COMMIT');
	} catch (error) {
		await dbExec(db, 'ROLLBACK');
		throw error;
	}
}

function dbOpen(path: string): Promise<Database> {
	return new Promise((resolvePromise, reject) => {
		import('@vscode/sqlite3').then(sqlite3 => {
			const db = new sqlite3.default.Database(path, (error: Error | null) => error ? reject(error) : resolvePromise(db));
		}, reject);
	});
}

function dbExec(db: Database, sql: string): Promise<void> {
	return new Promise((resolvePromise, reject) => db.exec(sql, error => error ? reject(error) : resolvePromise()));
}

function dbRun(db: Database, sql: string, parameters: unknown[]): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		db.run(sql, parameters, function (this: RunResult, error: Error | null) {
			error ? reject(error) : resolvePromise(this.changes);
		});
	});
}

function dbGet(db: Database, sql: string, parameters: unknown[]): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolvePromise, reject) => {
		db.get(sql, parameters, (error: Error | null, row: Record<string, unknown> | undefined) => error ? reject(error) : resolvePromise(row));
	});
}

function dbAll(db: Database, sql: string, parameters: unknown[]): Promise<Record<string, unknown>[]> {
	return new Promise((resolvePromise, reject) => {
		db.all(sql, parameters, (error: Error | null, rows: Record<string, unknown>[]) => error ? reject(error) : resolvePromise(rows));
	});
}

function dbClose(db: Database): Promise<void> {
	return new Promise((resolvePromise, reject) => db.close(error => error ? reject(error) : resolvePromise()));
}
