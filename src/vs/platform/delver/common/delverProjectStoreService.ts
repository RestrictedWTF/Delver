/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IDelverFindingDecisionWire, IDelverFindingWire } from './findings.js';
import { IInterpretationEditWire } from './delverInterpretationStoreService.js';
import { IDelverToolCallRecordWire } from './delverToolCall.js';
import { IDelverNamedSignatureWire } from './delverSignature.js';

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

export type DelverFunctionMigrationMethod = 'exact' | 'symbol' | 'structural' | 'manual';
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
	loadFunctionMigrationMappings(projectId: string, sourceRevisionId: string, targetRevisionId: string): Promise<readonly IDelverFunctionMigrationMapping[]>;
	appendInterpretations(projectId: string, edits: readonly IInterpretationEditWire[]): Promise<void>;
	appendFindings(projectId: string, findings: readonly IDelverFindingWire[]): Promise<void>;
	appendFindingDecisions(projectId: string, decisions: readonly IDelverFindingDecisionWire[]): Promise<void>;
	appendToolCalls(projectId: string, calls: readonly IDelverToolCallRecordWire[]): Promise<void>;
	upsertSignatures(projectId: string, signatures: readonly IDelverNamedSignatureWire[]): Promise<void>;
	copyInterpretations(sourceProjectId: string, destinationProjectId: string): Promise<number>;
	close(projectId: string): Promise<void>;
}
