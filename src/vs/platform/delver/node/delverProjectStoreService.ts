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
	IDelverRetainedXrefs,
} from '../common/delverProjectStoreService.js';
import {
	delverFindingDecisionFromWire,
	delverFindingDecisionToWire,
	delverFindingFromWire,
	delverFindingToWire,
	IDelverFindingDecisionWire,
	IDelverFindingWire,
} from '../common/findings.js';
import { IInterpretationEditWire, isContentHash } from '../common/delverInterpretationStoreService.js';
import { IAuthor } from '../common/interpretation.js';
import { delverToolCallFromWire, delverToolCallToWire, IDelverToolCallRecordWire } from '../common/delverToolCall.js';
import { delverNamedSignatureFromWire, delverNamedSignatureToWire, IDelverNamedSignature, IDelverNamedSignatureWire } from '../common/delverSignature.js';
import { IXrefWire, XrefKindWire } from '../common/protocol.generated.js';

const PROJECT_SCHEMA_VERSION = 8;
const WIRE_RVA = /^0x[0-9a-fA-F]+$/;
const SNAPSHOT_KINDS = ['imageInfo', 'functions', 'imports', 'exports', 'strings'] as const;
type SnapshotKind = typeof SNAPSHOT_KINDS[number];

/**
 * Width the xref columns pad addresses to, which is what makes them sortable.
 *
 * Addresses are `"0x..."` strings everywhere, and a variable-width hex string
 * does not compare numerically as TEXT — `"0x9000"` sorts after
 * `"0x1ffffffffffffff"` even though it is far smaller. Sixteen digits is a
 * whole `u64`, so a padded column compares as the number it stands for while
 * staying a valid wire address, which an INTEGER column would not: SQLite
 * would hand it back as a double and truncate it above 2^53. Values are
 * narrowed back to canonical `"0x..."` form on the way out.
 */
const XREF_RVA_DIGITS = 16;
const MAX_U64 = (1n << 64n) - 1n;

/** Rows per INSERT while retaining a table that can hold millions of them. */
const XREF_INSERT_BATCH = 200;

/**
 * `analysis_snapshots` kind recording how much of the xref table was retained.
 *
 * Reusing the generic per-revision fact table rather than adding a column keeps
 * the retention record where every other per-revision fact already lives, and
 * `loadSnapshot` ignores kinds it does not know, so the row is invisible to
 * readers that have no business with it.
 */
const XREFS_RETENTION_KIND = 'xrefsRetention';

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
	CREATE TABLE findings (
		id          TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload     TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		PRIMARY KEY (revision_id, id)
	);
	CREATE TABLE finding_decisions (
		id          TEXT PRIMARY KEY NOT NULL,
		finding_id  TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		payload     TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		UNIQUE (revision_id, finding_id),
		FOREIGN KEY (revision_id, finding_id) REFERENCES findings(revision_id, id)
	);
	CREATE TABLE tool_calls (
		call_id     TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload     TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		PRIMARY KEY (revision_id, call_id)
	);
	CREATE TABLE named_signatures (
		seq         INTEGER PRIMARY KEY AUTOINCREMENT,
		id          TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		name_key    TEXT,
		payload     TEXT,
		author_kind TEXT NOT NULL,
		author_id   TEXT NOT NULL,
		supersedes  INTEGER,
		tombstone   INTEGER NOT NULL,
		recorded_at INTEGER NOT NULL
	);
	CREATE INDEX named_signatures_current ON named_signatures (revision_id, id, seq);
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
	CREATE TABLE xrefs (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		from_rva    TEXT NOT NULL,
		to_rva      TEXT NOT NULL,
		kind        TEXT NOT NULL,
		PRIMARY KEY (revision_id, from_rva, to_rva, kind)
	);
	CREATE INDEX xrefs_to_idx ON xrefs(revision_id, to_rva, from_rva);
	PRAGMA user_version = ${PROJECT_SCHEMA_VERSION};
`;

const MIGRATE_V2_TO_V3 = `
	CREATE TABLE findings (
		id TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (revision_id, id)
	);
	PRAGMA user_version = 3;
`;

const MIGRATE_V3_TO_V4 = `
	CREATE TABLE finding_decisions (
		id TEXT PRIMARY KEY NOT NULL,
		finding_id TEXT NOT NULL,
		revision_id TEXT NOT NULL,
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		UNIQUE (revision_id, finding_id),
		FOREIGN KEY (revision_id, finding_id) REFERENCES findings(revision_id, id)
	);
	PRAGMA user_version = 4;
`;

const MIGRATE_V4_TO_V5 = `
	CREATE TABLE tool_calls (
		call_id TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (revision_id, call_id)
	);
	PRAGMA user_version = 5;
`;

const MIGRATE_V5_TO_V6 = `
	CREATE TABLE named_signatures (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		name_key TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE (revision_id, name_key)
	);
	PRAGMA user_version = 6;
`;

/**
 * Turns the signature table into an append-only record of authored decisions.
 *
 * A v6 row was rewritten in place on every rename or re-save and deleted
 * outright, taking the pattern, the retained proof and the `sourceCallId` that
 * proved it with it — the evidence `cross-revision-stable` generation reads
 * back. Each row is carried over as the first record for its signature,
 * attributed to the format migration because the original author was never
 * recorded to begin with.
 */
const MIGRATE_V6_TO_V7 = `
	CREATE TABLE named_signatures_v7 (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id), name_key TEXT, payload TEXT,
		author_kind TEXT NOT NULL, author_id TEXT NOT NULL, supersedes INTEGER,
		tombstone INTEGER NOT NULL, recorded_at INTEGER NOT NULL
	);
	INSERT INTO named_signatures_v7 (id, revision_id, name_key, payload, author_kind, author_id, supersedes, tombstone, recorded_at)
		SELECT id, revision_id, name_key, payload, 'import', 'delverdb-v6', NULL, 0, updated_at
		FROM named_signatures ORDER BY created_at, id;
	DROP TABLE named_signatures;
	ALTER TABLE named_signatures_v7 RENAME TO named_signatures;
	CREATE INDEX named_signatures_current ON named_signatures (revision_id, id, seq);
	PRAGMA user_version = 7;
`;

/**
 * Retains the cross-reference table, so a project answers `to` and `from`
 * without its sample (ADR 0012).
 *
 * Both orderings are stored, which is why there are two indexes: the primary
 * key already orders by `from_rva` as its leading edge after the revision, and
 * the extra index serves the `to` direction — the one that answers "who calls
 * this function", and it carries `from_rva` so that ordering is read off the
 * index rather than sorted. The Rust `XrefTable` keeps two sorted arrays for
 * exactly this reason. Nothing is backfilled: a v7 project retained no table
 * and must read as "never retained" rather than as an empty one, which is what
 * the absent `xrefsRetention` row says.
 */
const MIGRATE_V7_TO_V8 = `
	CREATE TABLE xrefs (
		revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
		from_rva TEXT NOT NULL, to_rva TEXT NOT NULL, kind TEXT NOT NULL,
		PRIMARY KEY (revision_id, from_rva, to_rva, kind)
	);
	CREATE INDEX xrefs_to_idx ON xrefs(revision_id, to_rva, from_rva);
	PRAGMA user_version = 8;
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
	PRAGMA user_version = 2;
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
					version = 2;
				}
				if (version === 2) {
					await transaction(db, () => dbExec(db, MIGRATE_V2_TO_V3));
					version = 3;
				}
				if (version === 3) {
					await transaction(db, () => dbExec(db, MIGRATE_V3_TO_V4));
					version = 4;
				}
				if (version === 4) {
					await transaction(db, () => dbExec(db, MIGRATE_V4_TO_V5));
					version = 5;
				}
				if (version === 5) {
					await transaction(db, () => dbExec(db, MIGRATE_V5_TO_V6));
					version = 6;
				}
				if (version === 6) {
					await transaction(db, () => dbExec(db, MIGRATE_V6_TO_V7));
					version = 7;
				}
				if (version === 7) {
					await transaction(db, () => dbExec(db, MIGRATE_V7_TO_V8));
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
			const findings = (await dbAll(project.db, 'SELECT payload FROM findings WHERE revision_id = ? ORDER BY created_at, rowid', [revision.revisionId]))
				.map(row => delverFindingToWire(delverFindingFromWire(JSON.parse(requireString(row.payload, 'finding payload')))));
			const findingDecisions = (await dbAll(project.db,
				'SELECT payload FROM finding_decisions WHERE revision_id = ? ORDER BY created_at, rowid', [revision.revisionId]))
				.map(row => delverFindingDecisionToWire(delverFindingDecisionFromWire(JSON.parse(requireString(row.payload, 'finding decision payload')))));
			const toolCalls = (await dbAll(project.db,
				'SELECT payload FROM tool_calls WHERE revision_id = ? ORDER BY created_at, rowid', [revision.revisionId]))
				.map(row => delverToolCallToWire(delverToolCallFromWire(JSON.parse(requireString(row.payload, 'tool-call payload')))));
			const signatures = [...await currentSignatureRecords(project.db, revision.revisionId)]
				.sort((left, right) => compareText(left.nameKey, right.nameKey) || compareText(left.id, right.id))
				.map(record => delverNamedSignatureToWire(record.signature));
			return {
				metadata: metadataForRevision(project.metadata, revision, project.metadata.updatedAt),
				...snapshots,
				decompiledFunctions,
				interpretations,
				findings,
				findingDecisions,
				toolCalls,
				signatures,
			};
		});
	}

	appendInterpretations(projectId: string, edits: readonly IInterpretationEditWire[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revisions = new Map<string, IDelverProjectRevision>();
			const batched = new Set<string>();
			const alreadyStored = new Set<string>();
			for (const edit of edits) {
				const revision = await findRevisionByContentHash(project.db, edit.anchor?.contentHash);
				if (!revision) {
					throw new Error('Interpretation belongs to different target bytes');
				}
				revisions.set(edit.anchor.contentHash, revision);
				const key = `${revision.revisionId}:${edit.seq}`;
				if (batched.has(key)) {
					throw new Error(`Interpretation batch contains sequence ${edit.seq} twice`);
				}
				batched.add(key);
				// Re-saving a log that is already stored is the ordinary case and
				// must stay idempotent. A *different* edit at the same sequence is
				// the collision two windows produce, and losing it here is losing
				// the only non-recomputable data in the project — so it is reported
				// rather than discarded.
				const existing = await dbGet(project.db,
					'SELECT payload FROM interpretations WHERE revision_id = ? AND seq = ?', [revision.revisionId, edit.seq]);
				if (existing) {
					const stored = JSON.parse(requireString(existing.payload, 'interpretation payload')) as IInterpretationEditWire;
					if (interpretationIdentity(stored) !== interpretationIdentity(edit)) {
						throw new Error(`Interpretation sequence ${edit.seq} conflicts with an edit already stored in this project`);
					}
					alreadyStored.add(key);
				}
			}
			const now = Date.now();
			const appended = edits.length - alreadyStored.size;
			await transaction(project.db, async () => {
				for (const edit of edits) {
					const revisionId = revisions.get(edit.anchor.contentHash)!.revisionId;
					if (alreadyStored.has(`${revisionId}:${edit.seq}`)) {
						continue;
					}
					await dbRun(project.db, 'INSERT INTO interpretations (seq, revision_id, payload, created_at) VALUES (?, ?, ?, ?)',
						[edit.seq, revisionId, JSON.stringify(edit), now]);
				}
				if (appended > 0) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (appended > 0) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	appendFindings(projectId: string, findings: readonly IDelverFindingWire[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const validated = findings.map(finding => delverFindingFromWire(finding));
			if (new Set(validated.map(finding => finding.id)).size !== validated.length) {
				throw new Error('Finding batch contains duplicate ids');
			}
			const revisions = new Map<string, IDelverProjectRevision>();
			for (const finding of validated) {
				const contentHashes = new Set([
					...finding.anchors.map(anchor => anchor.contentHash),
					...finding.evidence.map(entry => entry.anchor.contentHash),
				]);
				if (contentHashes.size !== 1) {
					throw new Error('Finding evidence must belong to one target revision');
				}
				const contentHash = [...contentHashes][0];
				const revision = await findRevisionByContentHash(project.db, contentHash);
				if (!revision) {
					throw new Error('Finding belongs to different target bytes');
				}
				revisions.set(finding.id, revision);
			}
			const now = Date.now();
			await transaction(project.db, async () => {
				for (let index = 0; index < findings.length; index++) {
					const finding = validated[index];
					await dbRun(project.db, 'INSERT OR IGNORE INTO findings (id, revision_id, payload, created_at) VALUES (?, ?, ?, ?)', [
						finding.id, revisions.get(finding.id)!.revisionId, JSON.stringify(findings[index]), finding.at,
					]);
				}
				if (findings.length > 0) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (findings.length > 0) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	appendFindingDecisions(projectId: string, decisions: readonly IDelverFindingDecisionWire[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const validated = decisions.map(decision => delverFindingDecisionFromWire(decision));
			if (new Set(validated.map(decision => decision.id)).size !== validated.length) {
				throw new Error('Finding decision batch contains duplicate ids');
			}
			if (new Set(validated.map(decision => decision.findingId)).size !== validated.length) {
				throw new Error('A finding decision batch cannot decide the same finding twice');
			}

			const revisions = new Map<string, string>();
			const alreadyStored = new Set<string>();
			for (const decision of validated) {
				const row = await dbGet(project.db, `SELECT f.payload, f.revision_id FROM findings f
					JOIN revisions r ON r.revision_id = f.revision_id
					WHERE f.id = ? AND r.content_hash = ?`, [decision.findingId, decision.contentHash]);
				if (!row) {
					throw new Error(`No pending finding ${decision.findingId}`);
				}
				const finding = delverFindingFromWire(JSON.parse(requireString(row.payload, 'finding payload')));
				if (finding.status !== 'proposed') {
					throw new Error(`Finding ${decision.findingId} is not proposed`);
				}
				const existing = await dbGet(project.db,
					'SELECT id, payload FROM finding_decisions WHERE revision_id = ? AND finding_id = ?',
					[requireString(row.revision_id, 'finding revision id'), decision.findingId]);
				if (existing) {
					const stored = delverFindingDecisionFromWire(JSON.parse(requireString(existing.payload, 'finding decision payload')));
					if (stored.id !== decision.id || JSON.stringify(delverFindingDecisionToWire(stored)) !== JSON.stringify(delverFindingDecisionToWire(decision))) {
						throw new Error(`Finding ${decision.findingId} has already been decided`);
					}
					alreadyStored.add(decision.id);
				}
				revisions.set(decision.id, requireString(row.revision_id, 'finding revision id'));
			}

			const now = Date.now();
			await transaction(project.db, async () => {
				for (const decision of validated) {
					if (alreadyStored.has(decision.id)) {
						continue;
					}
					await dbRun(project.db, `INSERT INTO finding_decisions
						(id, finding_id, revision_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`, [
						decision.id,
						decision.findingId,
						revisions.get(decision.id)!,
						JSON.stringify(delverFindingDecisionToWire(decision)),
						decision.at,
					]);
				}
				if (decisions.length > alreadyStored.size) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (decisions.length > alreadyStored.size) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	appendToolCalls(projectId: string, calls: readonly IDelverToolCallRecordWire[]): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const validated = calls.map(call => delverToolCallFromWire(call));
			if (new Set(validated.map(call => call.callId)).size !== validated.length) {
				throw new Error('Tool-call batch contains duplicate ids');
			}
			const revisions = new Map<string, IDelverProjectRevision>();
			const alreadyStored = new Set<string>();
			for (const call of validated) {
				const revision = await findRevisionByContentHash(project.db, call.contentHash);
				if (!revision) {
					throw new Error('Tool call belongs to different target bytes');
				}
				const existing = await dbGet(project.db,
					'SELECT payload FROM tool_calls WHERE revision_id = ? AND call_id = ?', [revision.revisionId, call.callId]);
				if (existing) {
					const stored = delverToolCallFromWire(JSON.parse(requireString(existing.payload, 'tool-call payload')));
					if (JSON.stringify(delverToolCallToWire(stored)) !== JSON.stringify(delverToolCallToWire(call))) {
						throw new Error(`Tool call ${call.callId} conflicts with an existing record`);
					}
					alreadyStored.add(call.callId);
				}
				revisions.set(call.callId, revision);
			}
			const now = Date.now();
			await transaction(project.db, async () => {
				for (const call of validated) {
					if (alreadyStored.has(call.callId)) {
						continue;
					}
					await dbRun(project.db, 'INSERT OR IGNORE INTO tool_calls (call_id, revision_id, payload, created_at) VALUES (?, ?, ?, ?)', [
						call.callId, revisions.get(call.callId)!.revisionId, JSON.stringify(delverToolCallToWire(call)), call.startedAt,
					]);
				}
				if (calls.length > alreadyStored.size) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (calls.length > alreadyStored.size) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	appendSignatures(projectId: string, signatures: readonly IDelverNamedSignatureWire[], author: IAuthor): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			validateAuthor(author);
			const validated = signatures.map(signature => delverNamedSignatureFromWire(signature));
			const names = validated.map(signature => signature.name.toLowerCase());
			if (new Set(names).size !== names.length || new Set(validated.map(signature => signature.id)).size !== validated.length) {
				throw new Error('Signature batch contains duplicate names or ids');
			}
			const revisions = new Map<string, IDelverProjectRevision>();
			const supersedes = new Map<string, number | null>();
			const unchanged = new Set<string>();
			const currentByRevision = new Map<string, readonly ISignatureRecord[]>();
			for (const signature of validated) {
				const revision = await findRevisionByContentHash(project.db, signature.contentHash);
				if (!revision) {
					throw new Error('Signature belongs to different target bytes');
				}
				const owner = await dbGet(project.db, 'SELECT revision_id FROM named_signatures WHERE id = ? LIMIT 1', [signature.id]);
				if (owner && requireString(owner.revision_id, 'signature revision id') !== revision.revisionId) {
					throw new Error(`Signature ${signature.id} belongs to different target bytes`);
				}
				let current = currentByRevision.get(revision.revisionId);
				if (!current) {
					current = await currentSignatureRecords(project.db, revision.revisionId);
					currentByRevision.set(revision.revisionId, current);
				}
				const conflicting = current.find(record => record.nameKey === signature.name.toLowerCase() && record.id !== signature.id);
				if (conflicting) {
					throw new Error(`Signature ${signature.name} conflicts with an existing id`);
				}
				const previous = current.find(record => record.id === signature.id);
				// Every save re-sends the whole retained set, so a signature that
				// says exactly what the current record already says appends nothing.
				// Appending it would bury the history under identical revisions.
				if (previous && signatureIdentity(previous.signature) === signatureIdentity(signature)) {
					unchanged.add(signature.id);
				}
				revisions.set(signature.id, revision);
				supersedes.set(signature.id, previous?.seq ?? null);
			}
			const appended = validated.filter(signature => !unchanged.has(signature.id));
			const now = Date.now();
			await transaction(project.db, async () => {
				for (const signature of appended) {
					await dbRun(project.db, `INSERT INTO named_signatures
						(id, revision_id, name_key, payload, author_kind, author_id, supersedes, tombstone, recorded_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, [
						signature.id, revisions.get(signature.id)!.revisionId, signature.name.toLowerCase(),
						JSON.stringify(delverNamedSignatureToWire(signature)),
						author.kind, author.id, supersedes.get(signature.id)!, now,
					]);
				}
				if (appended.length > 0) {
					await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
				}
			});
			if (appended.length > 0) {
				project.metadata = { ...project.metadata, updatedAt: now };
			}
		});
	}

	retireSignature(projectId: string, contentHash: string, signatureId: string, author: IAuthor): Promise<boolean> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			validateAuthor(author);
			if (signatureId.length === 0 || signatureId.length > 128) {
				throw new Error('Invalid signature id');
			}
			const revision = await findRevisionByContentHash(project.db, contentHash);
			if (!revision) {
				throw new Error('Signature belongs to different target bytes');
			}
			const current = await currentSignatureRecords(project.db, revision.revisionId);
			const record = current.find(entry => entry.id === signatureId);
			if (!record) {
				return false;
			}
			const now = Date.now();
			await transaction(project.db, async () => {
				// A tombstone, not a delete: the superseded records keep the pattern
				// and the proof that a later cross-revision match reads as evidence.
				await dbRun(project.db, `INSERT INTO named_signatures
					(id, revision_id, name_key, payload, author_kind, author_id, supersedes, tombstone, recorded_at)
					VALUES (?, ?, NULL, NULL, ?, ?, ?, 1, ?)`,
				[signatureId, revision.revisionId, author.kind, author.id, record.seq, now]);
				await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
			});
			project.metadata = { ...project.metadata, updatedAt: now };
			return true;
		});
	}

	copyInterpretations(sourceProjectId: string, destinationProjectId: string): Promise<number> {
		return this.sequencer.queue(async () => {
			const source = this.getProject(sourceProjectId);
			const destination = this.getProject(destinationProjectId);
			const rows = await dbAll(source.db, `SELECT i.seq, i.payload, r.content_hash FROM interpretations i
				JOIN revisions r ON r.revision_id = i.revision_id ORDER BY i.seq`, []);
			const destinationRevisions = new Map<string, IDelverProjectRevision>();
			const alreadyStored = new Set<string>();
			for (const row of rows) {
				const contentHash = requireString(row.content_hash, 'revision content hash');
				const revision = await findRevisionByContentHash(destination.db, contentHash);
				if (!revision) {
					throw new Error('Cannot copy interpretations between different target bytes');
				}
				destinationRevisions.set(contentHash, revision);
				const seq = requirePositiveInteger(row.seq, 'interpretation sequence');
				const existing = await dbGet(destination.db,
					'SELECT payload FROM interpretations WHERE revision_id = ? AND seq = ?', [revision.revisionId, seq]);
				if (existing) {
					const stored = JSON.parse(requireString(existing.payload, 'interpretation payload')) as IInterpretationEditWire;
					const incoming = JSON.parse(requireString(row.payload, 'interpretation payload')) as IInterpretationEditWire;
					if (interpretationIdentity(stored) !== interpretationIdentity(incoming)) {
						throw new Error(`Interpretation sequence ${seq} conflicts with an edit already stored in the destination project`);
					}
					alreadyStored.add(`${revision.revisionId}:${seq}`);
				}
			}
			const now = Date.now();
			let copied = 0;
			await transaction(destination.db, async () => {
				for (const row of rows) {
					const revision = destinationRevisions.get(requireString(row.content_hash, 'revision content hash'))!;
					const seq = requirePositiveInteger(row.seq, 'interpretation sequence');
					if (alreadyStored.has(`${revision.revisionId}:${seq}`)) {
						continue;
					}
					copied += await dbRun(destination.db, 'INSERT INTO interpretations (seq, revision_id, payload, created_at) VALUES (?, ?, ?, ?)',
						[seq, revision.revisionId, requireString(row.payload, 'interpretation payload'), now]);
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

	saveXrefs(projectId: string, xrefs: readonly IXrefWire[], complete: boolean, revisionId?: string): Promise<void> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revision = await requireRevision(project.db, revisionId ?? project.metadata.currentRevisionId);
			if (typeof complete !== 'boolean') {
				throw new Error('Cross-reference retention completeness must be stated');
			}
			// Every row is checked before anything is written, because the first
			// statement of the transaction drops the table that is already retained:
			// a batch that failed halfway would otherwise trade a good table for no
			// table.
			const rows = xrefs.map(xref => {
				if (!isXrefKind(xref?.kind)) {
					throw new Error('Invalid cross-reference kind');
				}
				return [xrefRva(xref.from), xrefRva(xref.to), xref.kind];
			});
			const now = Date.now();
			await transaction(project.db, async () => {
				await dbRun(project.db, 'DELETE FROM xrefs WHERE revision_id = ?', [revision.revisionId]);
				// Millions of rows one statement at a time is minutes of round trips,
				// so they go in batches — still inside the one transaction, so a
				// project never holds half a table.
				for (let start = 0; start < rows.length; start += XREF_INSERT_BATCH) {
					const batch = rows.slice(start, start + XREF_INSERT_BATCH);
					const parameters: unknown[] = [];
					for (const [from, to, kind] of batch) {
						parameters.push(revision.revisionId, from, to, kind);
					}
					await dbRun(project.db, `INSERT OR IGNORE INTO xrefs (revision_id, from_rva, to_rva, kind)
						VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`, parameters);
				}
				const retained = requireCount((await dbGet(project.db,
					'SELECT COUNT(*) AS total FROM xrefs WHERE revision_id = ?', [revision.revisionId]))?.total,
				'retained cross-reference count');
				await dbRun(project.db, `INSERT INTO analysis_snapshots (revision_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
					ON CONFLICT(revision_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
				[revision.revisionId, XREFS_RETENTION_KIND, JSON.stringify({ complete, total: retained }), now]);
				await dbRun(project.db, 'UPDATE project_metadata SET updated_at = ? WHERE id = 1', [now]);
			});
			project.metadata = { ...project.metadata, updatedAt: now };
		});
	}

	loadXrefs(projectId: string, rva: string, direction: 'to' | 'from', maxXrefs: number, revisionId?: string): Promise<IDelverRetainedXrefs> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revision = await requireRevision(project.db, revisionId ?? project.metadata.currentRevisionId);
			if (direction !== 'to' && direction !== 'from') {
				throw new Error('Cross-reference direction must be "to" or "from"');
			}
			// An unbounded lookup is refused rather than quietly defaulted, because a
			// zero bound reads back as an empty answer for a hot address.
			if (typeof maxXrefs !== 'number' || !Number.isSafeInteger(maxXrefs) || maxXrefs < 1) {
				throw new Error('Cross-reference bound must be a positive integer');
			}
			const address = xrefRva(rva);
			const column = direction === 'to' ? 'to_rva' : 'from_rva';
			const ordering = direction === 'to' ? 'from_rva, kind' : 'to_rva, kind';
			const retention = await readXrefRetention(project.db, revision.revisionId);
			// A count and a bounded page, never the whole table: one address in a
			// real module has tens of thousands of references, and the table has
			// millions.
			const total = requireCount((await dbGet(project.db,
				`SELECT COUNT(*) AS total FROM xrefs WHERE revision_id = ? AND ${column} = ?`,
				[revision.revisionId, address]))?.total, 'cross-reference count');
			const rows = await dbAll(project.db,
				`SELECT from_rva, to_rva, kind FROM xrefs WHERE revision_id = ? AND ${column} = ?
				 ORDER BY ${ordering} LIMIT ?`, [revision.revisionId, address, maxXrefs]);
			return {
				xrefs: rows.map(xrefFromRow),
				total,
				truncated: total > rows.length,
				complete: retention?.complete === true,
			};
		});
	}

	hasRetainedXrefs(projectId: string, revisionId?: string): Promise<boolean> {
		return this.sequencer.queue(async () => {
			const project = this.getProject(projectId);
			const revision = await requireRevision(project.db, revisionId ?? project.metadata.currentRevisionId);
			return await readXrefRetention(project.db, revision.revisionId) !== undefined;
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

/** The newest record for one signature id in one revision. */
interface ISignatureRecord {
	readonly seq: number;
	readonly id: string;
	readonly nameKey: string;
	readonly signature: IDelverNamedSignature;
}

/**
 * Resolves one revision's signature records to their current state.
 *
 * The table is an append-only record of authored decisions, so "the signature"
 * is the newest record for its id, and a tombstone means it has been retired.
 * Everything a retired or superseded record proved stays on disk.
 */
async function currentSignatureRecords(db: Database, revisionId: string): Promise<readonly ISignatureRecord[]> {
	const rows = await dbAll(db, `SELECT record.seq, record.id, record.name_key, record.payload
		FROM named_signatures record
		JOIN (SELECT id, MAX(seq) AS seq FROM named_signatures WHERE revision_id = ? GROUP BY id) current
			ON current.id = record.id AND current.seq = record.seq
		WHERE record.tombstone = 0`, [revisionId]);
	return rows.map(row => ({
		seq: requirePositiveInteger(row.seq, 'signature record sequence'),
		id: requireString(row.id, 'signature id'),
		nameKey: requireString(row.name_key, 'signature name key'),
		signature: delverNamedSignatureFromWire(JSON.parse(requireString(row.payload, 'signature payload'))),
	}));
}

/** Canonical form of one signature, so an unchanged re-save compares equal. */
function signatureIdentity(signature: IDelverNamedSignature): string {
	return JSON.stringify(delverNamedSignatureToWire(signature));
}

/**
 * Canonical form of one interpretation edit, independent of key order.
 *
 * Re-saving an already-stored log must compare equal; a *different* edit at the
 * same sequence must not, because that is the collision that would otherwise
 * lose an analyst's work.
 */
function interpretationIdentity(edit: IInterpretationEditWire): string {
	return JSON.stringify([
		edit.seq, edit.at, edit.author?.kind, edit.author?.id,
		edit.anchor?.kind, edit.anchor?.contentHash,
		edit.anchor?.kind === 'type' ? edit.anchor.name : edit.anchor?.rva?.toLowerCase(),
		edit.op, edit.value, edit.status,
		edit.compensates ?? null, edit.resolves ?? null,
	]);
}

function validateAuthor(author: IAuthor): void {
	if (!author || (author.kind !== 'human' && author.kind !== 'rule' && author.kind !== 'model' && author.kind !== 'import')
		|| typeof author.id !== 'string' || author.id.length === 0 || author.id.length > 128) {
		throw new Error('Invalid Delver project author');
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
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

/** What one revision's `xrefsRetention` row records about its retained table. */
interface IXrefRetention {
	readonly complete: boolean;
	readonly total: number;
}

/**
 * Reads the retention record, absent when nothing was ever retained.
 *
 * The absence is itself the answer: it separates a project that retained a
 * table in which one address genuinely has no references from a project that
 * retained nothing at all, and both otherwise report `total: 0`.
 */
async function readXrefRetention(db: Database, revisionId: string): Promise<IXrefRetention | undefined> {
	const row = await dbGet(db, 'SELECT payload FROM analysis_snapshots WHERE revision_id = ? AND kind = ?',
		[revisionId, XREFS_RETENTION_KIND]);
	if (!row) {
		return undefined;
	}
	const payload = JSON.parse(requireString(row.payload, 'cross-reference retention payload')) as Record<string, unknown>;
	return {
		// Anything other than a recorded `true` counts as incomplete, so a record
		// written by a build this one does not understand never claims more than
		// it can prove.
		complete: payload.complete === true,
		total: requireCount(payload.total, 'retained cross-reference count'),
	};
}

/**
 * Widens a wire address to the fixed width the xref columns are stored at.
 *
 * The padding is what makes `ORDER BY` on a TEXT column numeric, and putting
 * stored rows and lookup keys through the same function is what lets `0x1000`,
 * `0x01000` and `0X1000` written in capitals find one another.
 */
function xrefRva(rva: string): string {
	if (typeof rva !== 'string' || !WIRE_RVA.test(rva)) {
		throw new Error('Invalid cross-reference address');
	}
	const value = BigInt(rva);
	if (value > MAX_U64) {
		throw new Error('Cross-reference address exceeds 64 bits');
	}
	return `0x${value.toString(16).padStart(XREF_RVA_DIGITS, '0')}`;
}

function xrefFromRow(row: Record<string, unknown>): IXrefWire {
	const kind = requireString(row.kind, 'cross-reference kind');
	if (!isXrefKind(kind)) {
		throw new Error('Invalid cross-reference kind in Delver project');
	}
	return {
		from: normalizeRva(requireString(row.from_rva, 'cross-reference source address')),
		to: normalizeRva(requireString(row.to_rva, 'cross-reference target address')),
		kind,
	};
}

function isXrefKind(value: unknown): value is XrefKindWire {
	return value === XrefKindWire.Call || value === XrefKindWire.Jump
		|| value === XrefKindWire.ConditionalJump || value === XrefKindWire.Data;
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
	return value === 'exact' || value === 'symbol' || value === 'structural' || value === 'signature' || value === 'manual';
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

function requireCount(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
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
