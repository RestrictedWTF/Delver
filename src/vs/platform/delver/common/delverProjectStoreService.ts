/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IDelverFindingDecisionWire, IDelverFindingWire } from './findings.js';
import { IInterpretationEditWire } from './delverInterpretationStoreService.js';
import { IAuthor } from './interpretation.js';
import { IDelverToolCallRecordWire } from './delverToolCall.js';
import { IDelverNamedSignatureWire } from './delverSignature.js';
import { IXrefWire } from './protocol.generated.js';

export const IDelverProjectStoreService = createDecorator<IDelverProjectStoreService>('delverProjectStoreService');

/** Identity of the bytes analysed by a Delver project. Binary contents are deliberately excluded. */
export interface IDelverProjectTargetIdentity {
	readonly contentHash: string;
	readonly displayName: string;
	readonly sourcePath?: string;
	readonly byteLength?: number;
}

/** Durable metadata read from a `.delverdb` project. */
export interface IDelverProjectMetadata extends IDelverProjectTargetIdentity {
	readonly schemaVersion: number;
	readonly currentRevisionId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** One immutable target revision retained by a project. */
export interface IDelverProjectRevision extends IDelverProjectTargetIdentity {
	readonly revisionId: string;
	readonly createdAt: number;
}

/** An open project owned by the shared process. */
export interface IDelverProjectHandle {
	readonly projectId: string;
	readonly path: string;
	readonly metadata: IDelverProjectMetadata;
}

/** One backend's durable result for one function. */
export interface IDelverProjectDecompilation {
	readonly backendId: string;
	readonly backendVersion: string;
	/** Function RVA encoded as a `"0x..."` string. */
	readonly functionRva: string;
	readonly serialized: string;
}

/**
 * Wire-safe analysis state. The five index payloads are opaque, versioned JSON
 * emitted by the analysis provider. Supplying a field to `saveSnapshot`
 * replaces that category; omitted fields remain unchanged.
 */
export interface IDelverProjectSnapshotUpdate {
	readonly imageInfo?: string;
	readonly functions?: string;
	readonly imports?: string;
	readonly exports?: string;
	readonly strings?: string;
	/** Entries replace the same backend/version/RVA. An empty array clears every decompilation. */
	readonly decompiledFunctions?: readonly IDelverProjectDecompilation[];
}

/** Complete persisted state returned when a project is restored. */
export interface IDelverProjectSnapshot extends IDelverProjectSnapshotUpdate {
	readonly metadata: IDelverProjectMetadata;
	readonly interpretations: readonly IInterpretationEditWire[];
	readonly findings: readonly IDelverFindingWire[];
	readonly findingDecisions: readonly IDelverFindingDecisionWire[];
	readonly toolCalls: readonly IDelverToolCallRecordWire[];
	readonly signatures: readonly IDelverNamedSignatureWire[];
}

export type DelverFunctionMigrationMethod = 'exact' | 'symbol' | 'structural' | 'signature' | 'manual';
export type DelverFunctionMigrationStatus = 'proposed' | 'accepted' | 'rejected';

/** A durable relationship between functions in two target revisions. */
export interface IDelverFunctionMigrationMapping {
	readonly sourceRevisionId: string;
	readonly sourceRva: string;
	readonly targetRevisionId: string;
	readonly targetRva: string;
	readonly method: DelverFunctionMigrationMethod;
	/** Evidence strength in the inclusive range 0..1. */
	readonly confidence: number;
	readonly status: DelverFunctionMigrationStatus;
	/** Optional evidence or tool identifier that produced this mapping. */
	readonly provenance?: string;
}

/**
 * One address lookup answered from a project's retained cross-reference table.
 *
 * `complete` is the guard against the failure this table exists to prevent: a
 * partially retained table read as if it were whole answers a confident
 * `total: 0` for an address whose references simply were not exported. It is
 * false both when the retained table is known to be partial and when nothing
 * was retained at all, so a caller that only ever checks `complete` before
 * trusting `total` cannot get the distinction wrong.
 */
export interface IDelverRetainedXrefs {
	readonly xrefs: readonly IXrefWire[];
	/** Matching references before `maxXrefs` was applied. */
	readonly total: number;
	readonly truncated: boolean;
	/** False when the retained table itself is known to be incomplete. */
	readonly complete: boolean;
}

/** SQLite-backed project persistence hosted in the shared process. */
export interface IDelverProjectStoreService {
	readonly _serviceBrand: undefined;

	create(path: string, target: IDelverProjectTargetIdentity): Promise<IDelverProjectHandle>;
	open(path: string, expectedContentHash?: string): Promise<IDelverProjectHandle>;
	addRevision(projectId: string, target: IDelverProjectTargetIdentity, snapshot?: IDelverProjectSnapshotUpdate): Promise<IDelverProjectRevision>;
	listRevisions(projectId: string): Promise<readonly IDelverProjectRevision[]>;
	saveSnapshot(projectId: string, snapshot: IDelverProjectSnapshotUpdate, revisionId?: string): Promise<void>;
	loadSnapshot(projectId: string, revisionId?: string): Promise<IDelverProjectSnapshot>;
	storeFunctionMigrationMappings(projectId: string, mappings: readonly IDelverFunctionMigrationMapping[]): Promise<void>;
	/**
	 * Reads back what one revision's functions were matched to in another.
	 *
	 * Nothing consumes this yet; the matches are written on every revision so
	 * that the evidence exists when something does. The consumer is automatic
	 * interpretation transfer — carrying names and comments across a rebuild —
	 * which the ledger records as deliberately unimplemented. Writing the
	 * mappings only once a reader exists would leave every project created
	 * before that day with no history to transfer from, which is why the write
	 * runs ahead of the read rather than beside it. Do not delete it as dead.
	 */
	loadFunctionMigrationMappings(projectId: string, sourceRevisionId: string, targetRevisionId: string): Promise<readonly IDelverFunctionMigrationMapping[]>;
	appendInterpretations(projectId: string, edits: readonly IInterpretationEditWire[]): Promise<void>;
	appendFindings(projectId: string, findings: readonly IDelverFindingWire[]): Promise<void>;
	appendFindingDecisions(projectId: string, decisions: readonly IDelverFindingDecisionWire[]): Promise<void>;
	appendToolCalls(projectId: string, calls: readonly IDelverToolCallRecordWire[]): Promise<void>;
	/**
	 * Appends one authored record per signature, superseding the current one.
	 *
	 * Nothing is rewritten: a rename or a re-proof leaves the earlier record and
	 * its retained pattern, proof and `sourceCallId` in place, which is what a
	 * later `cross-revision-stable` match reads back as evidence. A signature
	 * identical to the current record appends nothing, so re-saving a project
	 * does not bury its history under copies of itself.
	 */
	appendSignatures(projectId: string, signatures: readonly IDelverNamedSignatureWire[], author: IAuthor): Promise<void>;

	/**
	 * Appends an authored tombstone, so the signature stops being current.
	 *
	 * Returns false when nothing was current to retire. The superseded records
	 * stay on disk — retiring a name is a decision, not an erasure.
	 */
	retireSignature(projectId: string, contentHash: string, signatureId: string, author: IAuthor): Promise<boolean>;
	/**
	 * Replaces the cross-references retained for one revision.
	 *
	 * `complete` records whether the export covered the whole table. Passing
	 * false for a table that was only partly walked is what keeps a later
	 * offline lookup from reporting an authoritative zero for an address the
	 * export never reached.
	 */
	saveXrefs(projectId: string, xrefs: readonly IXrefWire[], complete: boolean, revisionId?: string): Promise<void>;

	/**
	 * Answers one address from the retained table without loading it.
	 *
	 * A real module has millions of references, so this is a query bounded by
	 * `maxXrefs`, not a load: `total` counts every match before the bound.
	 */
	loadXrefs(projectId: string, rva: string, direction: 'to' | 'from', maxXrefs: number, revisionId?: string): Promise<IDelverRetainedXrefs>;

	/**
	 * Whether a revision has a retained table at all.
	 *
	 * This separates "retained, and this address genuinely has no references"
	 * from "nothing was ever retained, so no answer exists" — two states that
	 * `loadXrefs` otherwise reports with the same empty result and the same
	 * `total: 0`, distinguished only by `complete`.
	 */
	hasRetainedXrefs(projectId: string, revisionId?: string): Promise<boolean>;
	/**
	 * Merges one project's authored edits into another over the same bytes.
	 *
	 * Nothing calls this yet. It is the migration step from the legacy JSONL
	 * store and the merge half of "two analysts, one sample, two `.delverdb`
	 * files" — neither of which has a surface. Kept because the conflict rule it
	 * encodes is the load-bearing part: same sequence and same identity is a
	 * no-op, same sequence and different content refuses rather than
	 * overwriting, and a destination over different bytes refuses outright. That
	 * rule is far easier to keep proven by its tests than to rediscover later.
	 */
	copyInterpretations(sourceProjectId: string, destinationProjectId: string): Promise<number>;
	close(projectId: string): Promise<void>;
}
