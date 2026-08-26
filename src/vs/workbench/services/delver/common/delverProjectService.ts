/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AnalysisSessionId, IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import {
	createDelverFinding,
	createDelverFindingDecision,
	delverFindingDecisionFromWire,
	delverFindingDecisionToWire,
	delverFindingFromWire,
	delverFindingToWire,
	DelverFindingOutcome,
	IDelverFinding,
	IDelverFindingDecision,
	IDelverFindingDraft,
} from '../../../../platform/delver/common/findings.js';
import { IFingerprintedFunction, IFunctionRevisionMatch, matchFunctionRevisions } from '../../../../platform/delver/common/functionRevisionMatcher.js';
import { delverToolCallFromWire, delverToolCallToWire, IDelverToolCallRecord } from '../../../../platform/delver/common/delverToolCall.js';
import { DELVER_SIGNATURE_LIMITS, delverNamedSignatureFromWire, delverNamedSignatureToWire, IDelverNamedSignature, IDelverNamedSignatureDraft } from '../../../../platform/delver/common/delverSignature.js';
import { IDelverProjectDecompilation, IDelverProjectHandle, IDelverProjectRevision, IDelverProjectSnapshot, IDelverProjectSnapshotUpdate, IDelverProjectStoreService } from '../../../../platform/delver/common/delverProjectStoreService.js';
import { editFromWire, editToWire } from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { Anchor, EditOp, EditValue, IAuthor, InterpretationLog } from '../../../../platform/delver/common/interpretation.js';
import { IFunctionsResult } from '../../../../platform/delver/common/protocol.generated.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';

export const IDelverProjectService = createDecorator<IDelverProjectService>('delverProjectService');
const LOCAL_REVIEWER: IAuthor = { kind: 'human', id: 'local' };

/** The session information required to create or update a portable project. */
export interface IDelverProjectSession {
	readonly sessionId?: AnalysisSessionId;
	readonly targetPath: string;
	readonly contentHash: string;
}

/** A portable project restored independently of a live analysis provider. */
export interface IDelverOpenedProject {
	readonly path: string;
	readonly contentHash: string;
	readonly displayName: string;
	readonly sourcePath?: string;
	readonly snapshot: IDelverProjectSnapshot;
}

export interface IDelverFindingsChangeEvent {
	readonly contentHash: string;
	readonly findingIds: readonly string[];
	readonly kind: 'reported' | 'decided';
}

export interface IDelverSignaturesChangeEvent {
	readonly contentHash: string;
	readonly signatureIds: readonly string[];
}

/** One saved signature and the older project revision that proved it. */
export interface IDelverHistoricalSignature {
	readonly revision: IDelverProjectRevision;
	readonly signature: IDelverNamedSignature;
}

/** Durable evidence selected by a human after an earlier signature matched uniquely. */
export interface IDelverSignatureMigrationEvidence {
	readonly sourceRevisionId: string;
	readonly sourceSignatureId: string;
	readonly searchCallId: string;
	readonly generatedCallId: string;
	readonly targetSignatureId: string;
}

/** Interpretation effects produced while accepting a signature-backed migration. */
export interface IDelverSignatureMigrationResult {
	readonly transferredCount: number;
	readonly proposedCount: number;
	readonly unchangedCount: number;
}

/** Coordinates the active portable project and its incremental snapshots. */
export interface IDelverProjectService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeFindings: Event<IDelverFindingsChangeEvent>;
	readonly onDidChangeSignatures: Event<IDelverSignaturesChangeEvent>;

	/** Saves an untitled session, returning false when path selection or persistence was canceled. */
	save(session: IDelverProjectSession): Promise<boolean>;

	/** Appends updated bytes to the active project without replacing an older revision. */
	addRevision(previous: IDelverProjectSession, updated: IDelverProjectSession): Promise<boolean>;

	/** Creates and saves a separate named project while preserving the old project on failure. */
	createProject(session: IDelverProjectSession): Promise<boolean>;

	/** Opens a named portable project and loads its current revision snapshot. */
	openProject(path: string): Promise<IDelverOpenedProject>;

	/** Drops the active handle and any unsaved derived results for a closing session. */
	close(session: IDelverProjectSession): Promise<void>;

	/** Retains generated pseudocode and autosaves it once the project has a name. */
	recordDecompilation(contentHash: string, result: IDelverProjectDecompilation): Promise<void>;

	/** Appends a validation-atomic batch of durable findings for one target revision. */
	reportFindings(contentHash: string, drafts: readonly IDelverFindingDraft[]): Promise<readonly IDelverFinding[]>;

	/** Findings retained for one target revision, oldest first. */
	findingsFor(contentHash: string): readonly IDelverFinding[];

	/** Proposed findings with no later human decision, oldest first. */
	pendingFindings(contentHash: string): readonly IDelverFinding[];

	/** Appends human decisions after validating the complete finding batch. */
	resolveFindings(contentHash: string, findingIds: readonly string[], outcome: DelverFindingOutcome, reviewer?: IAuthor): Promise<readonly IDelverFindingDecision[]>;

	/** Human decision for one finding, when it has been reviewed. */
	findingDecisionFor(contentHash: string, findingId: string): IDelverFindingDecision | undefined;

	/** Retains one successful model-visible dispatcher exchange. */
	recordToolCall(record: IDelverToolCallRecord): Promise<void>;

	/** Successful dispatcher calls retained for one target revision, oldest first. */
	toolCallsFor(contentHash: string): readonly IDelverToolCallRecord[];

	/** Exact retained dispatcher call, when it belongs to these bytes. */
	toolCall(contentHash: string, callId: string): IDelverToolCallRecord | undefined;

	/** Creates or replaces one named signature, preserving its stable id by case-insensitive name. */
	saveSignature(contentHash: string, draft: IDelverNamedSignatureDraft): Promise<IDelverNamedSignature>;

	/** Renames one named signature while preserving its stable id and retained proof. */
	renameSignature(contentHash: string, signatureId: string, name: string): Promise<IDelverNamedSignature>;

	/** Permanently removes one named signature from this target revision. */
	deleteSignature(contentHash: string, signatureId: string): Promise<void>;

	/** Named signatures retained for one target revision, sorted by name. */
	signaturesFor(contentHash: string): readonly IDelverNamedSignature[];

	/** Saved signatures from every older revision of the active named project, newest revision first. */
	historicalSignaturesFor(contentHash: string): Promise<readonly IDelverHistoricalSignature[]>;

	/** Accepts one proven signature match and transfers its function interpretation with conflicts proposed for review. */
	acceptSignatureMigration(contentHash: string, evidence: IDelverSignatureMigrationEvidence): Promise<IDelverSignatureMigrationResult>;

	/** Path of the named project for these bytes, when the session is no longer untitled. */
	projectPath(contentHash: string): string | undefined;

	/** Snapshot for the active named project, when it was opened or saved. */
	projectSnapshot(contentHash: string): IDelverProjectSnapshot | undefined;
}

/** Renderer coordinator for the shared-process SQLite project store. */
export class DelverProjectService extends Disposable implements IDelverProjectService {
	readonly _serviceBrand: undefined;
	private readonly _onDidChangeFindings = this._register(new Emitter<IDelverFindingsChangeEvent>());
	readonly onDidChangeFindings = this._onDidChangeFindings.event;
	private readonly _onDidChangeSignatures = this._register(new Emitter<IDelverSignaturesChangeEvent>());
	readonly onDidChangeSignatures = this._onDidChangeSignatures.event;

	private active: { readonly contentHash: string; readonly revisionId: string; readonly handle: IDelverProjectHandle; snapshot?: IDelverProjectSnapshot } | undefined;
	private readonly pendingDecompilations = new Map<string, Map<string, IDelverProjectDecompilation>>();
	private readonly findings = new Map<string, IDelverFinding[]>();
	private readonly findingDecisions = new Map<string, IDelverFindingDecision[]>();
	private readonly toolCalls = new Map<string, IDelverToolCallRecord[]>();
	private readonly signatures = new Map<string, IDelverNamedSignature[]>();
	private readonly findingReviews = new SequencerByKey<string>();
	private readonly toolCallRecords = new SequencerByKey<string>();
	private readonly signatureRecords = new SequencerByKey<string>();

	constructor(
		@IDelverProjectStoreService private readonly storeService: IDelverProjectStoreService,
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this._register(this.interpretationService.onDidChange(event => {
			const active = this.active;
			if (active?.contentHash === event.edit.anchor.contentHash) {
				void this.storeService.appendInterpretations(active.handle.projectId, [editToWire(event.edit)]).catch(error => {
					void this.dialogService.error(
						localize('delverProjectAutosaveFailed', "Could not autosave the Delver project."),
						errorMessage(error),
					);
				});
			}
		}));
	}

	async save(session: IDelverProjectSession): Promise<boolean> {
		try {
			let active = this.active?.contentHash === session.contentHash ? this.active : undefined;
			if (!active) {
				const defaultUri = URI.file(join(dirname(session.targetPath), `${basename(session.targetPath)}.delverdb`));
				const destination = await this.fileDialogService.showSaveDialog({
					title: localize('delverSaveProjectTitle', "Save Delver Project"),
					saveLabel: localize({ key: 'delverSaveProjectLabel', comment: ['&& denotes a mnemonic'] }, "&&Save Project"),
					defaultUri,
					filters: [{ name: localize('delverProjectFileFilter', "Delver Project"), extensions: ['delverdb'] }],
					availableFileSystems: ['file'],
				});
				if (!destination || destination.scheme !== 'file') {
					return false;
				}
				const handle = await this.storeService.create(destination.fsPath, {
					contentHash: session.contentHash,
					displayName: basename(session.targetPath),
					sourcePath: session.targetPath,
				});
				active = { contentHash: session.contentHash, revisionId: handle.metadata.currentRevisionId, handle };
				this.active = active;
			}

			await this.storeService.saveSnapshot(active.handle.projectId, await this.snapshotFor(session));
			await this.storeService.appendInterpretations(
				active.handle.projectId,
				this.interpretationService.logFor(session.contentHash).map(editToWire),
			);
			await this.storeService.appendToolCalls(
				active.handle.projectId,
				this.toolCallsFor(session.contentHash).map(delverToolCallToWire),
			);
			await this.storeService.appendFindings(
				active.handle.projectId,
				this.findingsFor(session.contentHash).map(delverFindingToWire),
			);
			await this.storeService.appendFindingDecisions(
				active.handle.projectId,
				(this.findingDecisions.get(session.contentHash) ?? []).map(delverFindingDecisionToWire),
			);
			await this.storeService.upsertSignatures(
				active.handle.projectId,
				this.signaturesFor(session.contentHash).map(delverNamedSignatureToWire),
			);
			active.snapshot = await this.storeService.loadSnapshot(active.handle.projectId, active.revisionId);
			this.pendingDecompilations.delete(session.contentHash);
			return true;
		} catch (error) {
			await this.dialogService.error(
				localize('delverProjectSaveFailed', "Could not save the Delver project."),
				errorMessage(error),
			);
			return false;
		}
	}

	async addRevision(previous: IDelverProjectSession, updated: IDelverProjectSession): Promise<boolean> {
		const active = this.active;
		if (!active || active.contentHash !== previous.contentHash || previous.contentHash === updated.contentHash) {
			return false;
		}

		let revisionId: string;
		let matches: readonly IFunctionRevisionMatch[];
		try {
			// Gather every fallible provider result before changing which revision
			// the project considers current. The store then writes this snapshot
			// under the new revision id, never over the previous revision's rows.
			const [sourceSnapshot, snapshot] = await Promise.all([
				this.storeService.loadSnapshot(active.handle.projectId, active.revisionId),
				this.snapshotFor(updated),
			]);
			matches = matchFunctionRevisions(
				{ contentHash: previous.contentHash, functions: fingerprintedFunctions(sourceSnapshot.functions) },
				{ contentHash: updated.contentHash, functions: fingerprintedFunctions(snapshot.functions) },
			).matches;
			const revision = await this.storeService.addRevision(active.handle.projectId, {
				contentHash: updated.contentHash,
				displayName: basename(updated.targetPath),
				sourcePath: updated.targetPath,
			}, snapshot);
			revisionId = revision.revisionId;
			await this.storeService.storeFunctionMigrationMappings(active.handle.projectId, matches.map(match => ({
				sourceRevisionId: active.revisionId,
				sourceRva: match.source.rva,
				targetRevisionId: revision.revisionId,
				targetRva: match.target.rva,
				method: 'exact',
				confidence: match.confidence,
				status: 'accepted',
				provenance: JSON.stringify(match.provenance),
			})));
			this.pendingDecompilations.delete(updated.contentHash);
		} catch (error) {
			await this.dialogService.error(
				localize('delverProjectRevisionFailed', "Could not add the updated binary as a project revision."),
				errorMessage(error),
			);
			return false;
		}

		// The revision is durable at this point. Interpretation migration is
		// best-effort and append-only: a failure must not roll the workbench back
		// to a revision whose database transaction already committed.
		this.active = { contentHash: updated.contentHash, revisionId, handle: active.handle };
		try {
			await this.migrateFunctionInterpretations(previous.contentHash, updated.contentHash, matches);
			await this.storeService.appendInterpretations(
				active.handle.projectId,
				this.interpretationService.logFor(updated.contentHash).map(editToWire),
			);
			await this.storeService.appendToolCalls(
				active.handle.projectId,
				this.toolCallsFor(updated.contentHash).map(delverToolCallToWire),
			);
			await this.storeService.appendFindings(
				active.handle.projectId,
				this.findingsFor(updated.contentHash).map(delverFindingToWire),
			);
			await this.storeService.appendFindingDecisions(
				active.handle.projectId,
				(this.findingDecisions.get(updated.contentHash) ?? []).map(delverFindingDecisionToWire),
			);
			await this.storeService.upsertSignatures(
				active.handle.projectId,
				this.signaturesFor(updated.contentHash).map(delverNamedSignatureToWire),
			);
		} catch (error) {
			await this.dialogService.error(
				localize('delverProjectMigrationFailed', "The updated binary was saved, but some interpretations could not be migrated."),
				errorMessage(error),
			);
		}
		return true;
	}

	async createProject(session: IDelverProjectSession): Promise<boolean> {
		let handle: IDelverProjectHandle | undefined;
		try {
			const defaultUri = URI.file(join(dirname(session.targetPath), `${basename(session.targetPath)}.delverdb`));
			const destination = await this.fileDialogService.showSaveDialog({
				title: localize('delverCreateProjectTitle', "Create Delver Project"),
				saveLabel: localize({ key: 'delverCreateProjectLabel', comment: ['&& denotes a mnemonic'] }, "&&Create Project"),
				defaultUri,
				filters: [{ name: localize('delverProjectFileFilter', "Delver Project"), extensions: ['delverdb'] }],
				availableFileSystems: ['file'],
			});
			if (!destination || destination.scheme !== 'file') {
				return false;
			}

			// Do not disturb the old active handle until the candidate has a
			// complete snapshot and its own append-only project file.
			const snapshot = await this.snapshotFor(session);
			handle = await this.storeService.create(destination.fsPath, {
				contentHash: session.contentHash,
				displayName: basename(session.targetPath),
				sourcePath: session.targetPath,
			});
			await this.storeService.saveSnapshot(handle.projectId, snapshot);
			await this.storeService.appendInterpretations(
				handle.projectId,
				this.interpretationService.logFor(session.contentHash).map(editToWire),
			);
			await this.storeService.appendToolCalls(
				handle.projectId,
				this.toolCallsFor(session.contentHash).map(delverToolCallToWire),
			);
			await this.storeService.appendFindings(
				handle.projectId,
				this.findingsFor(session.contentHash).map(delverFindingToWire),
			);
			await this.storeService.appendFindingDecisions(
				handle.projectId,
				(this.findingDecisions.get(session.contentHash) ?? []).map(delverFindingDecisionToWire),
			);
			await this.storeService.upsertSignatures(
				handle.projectId,
				this.signaturesFor(session.contentHash).map(delverNamedSignatureToWire),
			);

			const previous = this.active;
			this.active = { contentHash: session.contentHash, revisionId: handle.metadata.currentRevisionId, handle };
			this.pendingDecompilations.delete(session.contentHash);
			if (previous) {
				await this.storeService.close(previous.handle.projectId).catch(() => undefined);
			}
			return true;
		} catch (error) {
			if (handle) {
				await this.storeService.close(handle.projectId).catch(() => undefined);
			}
			await this.dialogService.error(
				localize('delverCreateProjectFailed', "Could not create a project for the updated binary."),
				errorMessage(error),
			);
			return false;
		}
	}

	async openProject(path: string): Promise<IDelverOpenedProject> {
		let handle: IDelverProjectHandle | undefined;
		try {
			handle = await this.storeService.open(path);
			const snapshot = await this.storeService.loadSnapshot(handle.projectId, handle.metadata.currentRevisionId);
			const previous = this.active;
			this.interpretationService.loadFromProject(snapshot.metadata.contentHash, snapshot.interpretations);
			this.findings.set(snapshot.metadata.contentHash, snapshot.findings.map(delverFindingFromWire));
			this.findingDecisions.set(snapshot.metadata.contentHash, snapshot.findingDecisions.map(delverFindingDecisionFromWire));
			this.toolCalls.set(snapshot.metadata.contentHash, snapshot.toolCalls.map(delverToolCallFromWire));
			this.signatures.set(snapshot.metadata.contentHash, snapshot.signatures.map(delverNamedSignatureFromWire));
			this.active = {
				contentHash: snapshot.metadata.contentHash,
				revisionId: snapshot.metadata.currentRevisionId,
				handle,
				snapshot,
			};
			if (previous) {
				await this.storeService.close(previous.handle.projectId).catch(() => undefined);
			}
			return {
				path: handle.path,
				contentHash: snapshot.metadata.contentHash,
				displayName: snapshot.metadata.displayName,
				sourcePath: snapshot.metadata.sourcePath,
				snapshot,
			};
		} catch (error) {
			if (handle) {
				await this.storeService.close(handle.projectId).catch(() => undefined);
			}
			throw error;
		}
	}

	async close(session: IDelverProjectSession): Promise<void> {
		this.pendingDecompilations.delete(session.contentHash);
		this.findings.delete(session.contentHash);
		this.findingDecisions.delete(session.contentHash);
		this.toolCalls.delete(session.contentHash);
		this.signatures.delete(session.contentHash);
		// Interpretation is cached by content hash and was the one category not
		// dropped here. `loadFromProject` replaces the log with the *project's*
		// authored edits, and `load` returns early when a log is already
		// cached — so without this, closing a project and opening the same
		// bytes plainly still shows that project's names, and saving would
		// write them into a new project as if authored there.
		this.interpretationService.unload(session.contentHash);
		if (this.active?.contentHash !== session.contentHash) {
			return;
		}
		const projectId = this.active.handle.projectId;
		this.active = undefined;
		await this.storeService.close(projectId);
	}

	async recordDecompilation(contentHash: string, result: IDelverProjectDecompilation): Promise<void> {
		let pending = this.pendingDecompilations.get(contentHash);
		if (!pending) {
			pending = new Map<string, IDelverProjectDecompilation>();
			this.pendingDecompilations.set(contentHash, pending);
		}
		const key = `${result.backendId}\0${result.backendVersion}\0${result.functionRva}`;
		pending.set(key, result);

		if (this.active?.contentHash === contentHash) {
			try {
				await this.storeService.saveSnapshot(this.active.handle.projectId, { decompiledFunctions: [result] });
				if (this.active.snapshot) {
					const identity = `${result.backendId}\0${result.backendVersion}\0${normalizeProjectRva(result.functionRva)}`;
					this.active.snapshot = {
						...this.active.snapshot,
						decompiledFunctions: [
							...(this.active.snapshot.decompiledFunctions ?? []).filter(candidate =>
								`${candidate.backendId}\0${candidate.backendVersion}\0${normalizeProjectRva(candidate.functionRva)}` !== identity),
							result,
						],
					};
				}
				pending.delete(key);
				if (pending.size === 0) {
					this.pendingDecompilations.delete(contentHash);
				}
			} catch (error) {
				await this.dialogService.error(
					localize('delverProjectAutosaveFailed', "Could not autosave the Delver project."),
					errorMessage(error),
				);
			}
		}
	}

	async reportFindings(contentHash: string, drafts: readonly IDelverFindingDraft[]): Promise<readonly IDelverFinding[]> {
		const now = Date.now();
		const findings = drafts.map(draft => createDelverFinding(generateUuid(), now, draft));
		for (const finding of findings) {
			if (finding.anchors.some(anchor => anchor.contentHash !== contentHash)) {
				throw new Error('Finding belongs to different target bytes');
			}
			for (const evidence of finding.evidence) {
				for (const callId of evidence.sourceCallIds ?? []) {
					if (!this.toolCall(contentHash, callId)) {
						throw new Error(`Finding cites unknown tool call ${callId}`);
					}
				}
			}
		}

		const active = this.active?.contentHash === contentHash ? this.active : undefined;
		if (active) {
			await this.storeService.appendFindings(active.handle.projectId, findings.map(delverFindingToWire));
		}
		const retained = this.findings.get(contentHash) ?? [];
		retained.push(...findings);
		this.findings.set(contentHash, retained);
		if (active?.snapshot) {
			active.snapshot = { ...active.snapshot, findings: [...active.snapshot.findings, ...findings.map(delverFindingToWire)] };
		}
		if (findings.length > 0) {
			this._onDidChangeFindings.fire({ contentHash, findingIds: findings.map(finding => finding.id), kind: 'reported' });
		}
		return findings;
	}

	findingsFor(contentHash: string): readonly IDelverFinding[] {
		return this.findings.get(contentHash) ?? [];
	}

	pendingFindings(contentHash: string): readonly IDelverFinding[] {
		const decided = new Set((this.findingDecisions.get(contentHash) ?? []).map(decision => decision.findingId));
		return this.findingsFor(contentHash).filter(finding => finding.status === 'proposed' && !decided.has(finding.id));
	}

	resolveFindings(
		contentHash: string,
		findingIds: readonly string[],
		outcome: DelverFindingOutcome,
		reviewer: IAuthor = LOCAL_REVIEWER,
	): Promise<readonly IDelverFindingDecision[]> {
		return this.findingReviews.queue(contentHash, async () => {
			if (new Set(findingIds).size !== findingIds.length) {
				throw new Error('A review batch cannot decide the same finding twice');
			}
			const findings = new Map(this.findingsFor(contentHash).map(finding => [finding.id, finding]));
			const existing = new Set((this.findingDecisions.get(contentHash) ?? []).map(decision => decision.findingId));
			const selected = findingIds.map(id => {
				const finding = findings.get(id);
				if (!finding || finding.status !== 'proposed') {
					throw new Error(`No pending finding ${id}`);
				}
				if (existing.has(id)) {
					throw new Error(`Finding ${id} has already been decided`);
				}
				return finding;
			});
			const now = Date.now();
			const decisions = selected.map(finding => createDelverFindingDecision(generateUuid(), finding, outcome, reviewer, now));
			const active = this.active?.contentHash === contentHash ? this.active : undefined;
			if (active) {
				await this.storeService.appendFindingDecisions(active.handle.projectId, decisions.map(delverFindingDecisionToWire));
			}
			const retained = this.findingDecisions.get(contentHash) ?? [];
			retained.push(...decisions);
			this.findingDecisions.set(contentHash, retained);
			if (active?.snapshot) {
				active.snapshot = {
					...active.snapshot,
					findingDecisions: [...active.snapshot.findingDecisions, ...decisions.map(delverFindingDecisionToWire)],
				};
			}
			if (decisions.length > 0) {
				this._onDidChangeFindings.fire({ contentHash, findingIds: [...findingIds], kind: 'decided' });
			}
			return decisions;
		});
	}

	findingDecisionFor(contentHash: string, findingId: string): IDelverFindingDecision | undefined {
		return (this.findingDecisions.get(contentHash) ?? []).find(decision => decision.findingId === findingId);
	}

	recordToolCall(record: IDelverToolCallRecord): Promise<void> {
		const validated = delverToolCallFromWire(delverToolCallToWire(record));
		return this.toolCallRecords.queue(validated.contentHash, async () => {
			const retained = this.toolCalls.get(validated.contentHash) ?? [];
			const existing = retained.find(call => call.callId === validated.callId);
			if (existing) {
				if (JSON.stringify(delverToolCallToWire(existing)) !== JSON.stringify(delverToolCallToWire(validated))) {
					throw new Error(`Tool call ${validated.callId} conflicts with an existing record`);
				}
				return;
			}
			const active = this.active?.contentHash === validated.contentHash ? this.active : undefined;
			if (active) {
				await this.storeService.appendToolCalls(active.handle.projectId, [delverToolCallToWire(validated)]);
			}
			retained.push(validated);
			this.toolCalls.set(validated.contentHash, retained);
			if (active?.snapshot) {
				active.snapshot = { ...active.snapshot, toolCalls: [...active.snapshot.toolCalls, delverToolCallToWire(validated)] };
			}
		});
	}

	toolCallsFor(contentHash: string): readonly IDelverToolCallRecord[] {
		return this.toolCalls.get(contentHash) ?? [];
	}

	toolCall(contentHash: string, callId: string): IDelverToolCallRecord | undefined {
		return this.toolCallsFor(contentHash).find(call => call.callId === callId);
	}

	saveSignature(contentHash: string, draft: IDelverNamedSignatureDraft): Promise<IDelverNamedSignature> {
		return this.signatureRecords.queue(contentHash, async () => {
			const retained = [...this.signaturesFor(contentHash)];
			const existingIndex = retained.findIndex(signature => signature.name.toLowerCase() === draft.name.toLowerCase());
			const existing = existingIndex < 0 ? undefined : retained[existingIndex];
			const now = Date.now();
			const signature = delverNamedSignatureFromWire({
				...draft,
				id: existing?.id ?? generateUuid(),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
			if (signature.contentHash !== contentHash) {
				throw new Error('Signature belongs to different target bytes');
			}
			const active = this.active?.contentHash === contentHash ? this.active : undefined;
			if (active) {
				await this.storeService.upsertSignatures(active.handle.projectId, [delverNamedSignatureToWire(signature)]);
			}
			if (existingIndex < 0) {
				retained.push(signature);
			} else {
				retained[existingIndex] = signature;
			}
			retained.sort(compareSignatureNames);
			this.signatures.set(contentHash, retained);
			if (active?.snapshot) {
				active.snapshot = { ...active.snapshot, signatures: retained.map(delverNamedSignatureToWire) };
			}
			this._onDidChangeSignatures.fire({ contentHash, signatureIds: [signature.id] });
			return signature;
		});
	}

	renameSignature(contentHash: string, signatureId: string, name: string): Promise<IDelverNamedSignature> {
		return this.signatureRecords.queue(contentHash, async () => {
			if (name.length === 0 || name.length > DELVER_SIGNATURE_LIMITS.nameCharacters || name.trim() !== name) {
				throw new Error('Invalid signature name');
			}
			const retained = [...this.signaturesFor(contentHash)];
			const existingIndex = retained.findIndex(signature => signature.id === signatureId);
			if (existingIndex < 0) {
				throw new Error('Signature no longer exists');
			}
			const conflicting = retained.find(signature => signature.id !== signatureId && signature.name.toLowerCase() === name.toLowerCase());
			if (conflicting) {
				throw new Error(`A signature named ${name} already exists`);
			}
			const renamed = delverNamedSignatureFromWire({ ...retained[existingIndex], name, updatedAt: Date.now() });
			const active = this.active?.contentHash === contentHash ? this.active : undefined;
			if (active) {
				await this.storeService.upsertSignatures(active.handle.projectId, [delverNamedSignatureToWire(renamed)]);
			}
			retained[existingIndex] = renamed;
			retained.sort(compareSignatureNames);
			this.signatures.set(contentHash, retained);
			if (active?.snapshot) {
				active.snapshot = { ...active.snapshot, signatures: retained.map(delverNamedSignatureToWire) };
			}
			this._onDidChangeSignatures.fire({ contentHash, signatureIds: [signatureId] });
			return renamed;
		});
	}

	deleteSignature(contentHash: string, signatureId: string): Promise<void> {
		return this.signatureRecords.queue(contentHash, async () => {
			const retained = [...this.signaturesFor(contentHash)];
			const existingIndex = retained.findIndex(signature => signature.id === signatureId);
			if (existingIndex < 0) {
				throw new Error('Signature no longer exists');
			}
			const active = this.active?.contentHash === contentHash ? this.active : undefined;
			if (active && !await this.storeService.deleteSignature(active.handle.projectId, contentHash, signatureId)) {
				throw new Error('Signature no longer exists in the project');
			}
			retained.splice(existingIndex, 1);
			this.signatures.set(contentHash, retained);
			if (active?.snapshot) {
				active.snapshot = { ...active.snapshot, signatures: retained.map(delverNamedSignatureToWire) };
			}
			this._onDidChangeSignatures.fire({ contentHash, signatureIds: [signatureId] });
		});
	}

	signaturesFor(contentHash: string): readonly IDelverNamedSignature[] {
		return this.signatures.get(contentHash) ?? [];
	}

	async historicalSignaturesFor(contentHash: string): Promise<readonly IDelverHistoricalSignature[]> {
		const active = this.active;
		if (!active || active.contentHash !== contentHash) {
			return [];
		}
		const revisions = (await this.storeService.listRevisions(active.handle.projectId))
			.filter(revision => revision.contentHash !== contentHash)
			.sort((left, right) => right.createdAt - left.createdAt
				|| (left.revisionId < right.revisionId ? 1 : left.revisionId > right.revisionId ? -1 : 0));
		const snapshots = await Promise.all(revisions.map(revision => this.storeService.loadSnapshot(active.handle.projectId, revision.revisionId)));
		return revisions.flatMap((revision, index) => snapshots[index].signatures
			.map(delverNamedSignatureFromWire)
			.sort(compareSignatureNames)
			.map(signature => ({ revision, signature })));
	}

	async acceptSignatureMigration(contentHash: string, evidence: IDelverSignatureMigrationEvidence): Promise<IDelverSignatureMigrationResult> {
		const active = this.active;
		if (!active || active.contentHash !== contentHash) {
			throw new Error('Signature migration requires the active named project revision');
		}
		if (evidence.sourceRevisionId === active.revisionId) {
			throw new Error('Signature migration source must be an earlier project revision');
		}
		const targetSignature = this.signaturesFor(contentHash).find(signature => signature.id === evidence.targetSignatureId);
		if (!targetSignature || targetSignature.variant !== 'primary' || targetSignature.policy !== 'cross-revision-stable'
			|| !targetSignature.unique || !targetSignature.matchCountExact || targetSignature.matchCount !== 1) {
			throw new Error('Signature migration requires a saved unique cross-revision primary signature for the current revision');
		}
		if (targetSignature.sourceCallId !== evidence.generatedCallId) {
			throw new Error('Signature migration target has invalid generation evidence');
		}
		const sourceSnapshot = await this.storeService.loadSnapshot(active.handle.projectId, evidence.sourceRevisionId);
		const sourceSignature = sourceSnapshot.signatures
			.map(delverNamedSignatureFromWire)
			.find(signature => signature.id === evidence.sourceSignatureId);
		if (!sourceSignature || sourceSignature.contentHash !== sourceSnapshot.metadata.contentHash
			|| sourceSignature.variant !== 'primary' || !sourceSignature.unique || !sourceSignature.matchCountExact || sourceSignature.matchCount !== 1) {
			throw new Error('Signature migration source is not a saved unique primary signature in that revision');
		}
		const searchCall = this.toolCall(contentHash, evidence.searchCallId);
		if (!searchCall || searchCall.capability !== 'delver_search_bytes') {
			throw new Error('Signature migration requires retained byte-search evidence for the current revision');
		}
		const generatedCall = this.toolCall(contentHash, evidence.generatedCallId);
		if (!generatedCall || generatedCall.capability !== 'delver_make_signature') {
			throw new Error('Signature migration requires retained generation evidence for the current revision');
		}
		validateSignatureSearchProof(searchCall.resultJson, sourceSignature.pattern, targetSignature.functionRva);
		validateSignatureGenerationProof(
			generatedCall.resultJson,
			evidence.sourceRevisionId,
			evidence.sourceSignatureId,
			targetSignature.pattern,
			targetSignature.functionRva,
		);

		await this.storeService.storeFunctionMigrationMappings(active.handle.projectId, [{
			sourceRevisionId: evidence.sourceRevisionId,
			sourceRva: sourceSignature.functionRva,
			targetRevisionId: active.revisionId,
			targetRva: targetSignature.functionRva,
			method: 'signature',
			confidence: Math.min(sourceSignature.qualityScore, targetSignature.qualityScore),
			status: 'accepted',
			provenance: JSON.stringify({
				kind: 'named-signature',
				sourceContentHash: sourceSignature.contentHash,
				targetContentHash: targetSignature.contentHash,
				sourceSignatureId: sourceSignature.id,
				targetSignatureId: targetSignature.id,
				searchCallId: searchCall.callId,
				generatedCallId: generatedCall.callId,
				pattern: sourceSignature.pattern,
			}),
		}]);

		const sourceLog = InterpretationLog.from(sourceSnapshot.interpretations.map(editFromWire));
		const source = sourceLog.at({ kind: 'image', contentHash: sourceSignature.contentHash, rva: BigInt(sourceSignature.functionRva) });
		if (!source) {
			return { transferredCount: 0, proposedCount: 0, unchangedCount: 0 };
		}
		const targetAnchor: Anchor = { kind: 'image', contentHash, rva: BigInt(targetSignature.functionRva) };
		const author: IAuthor = { kind: 'import', id: `signature:${sourceSignature.id}` };
		let transferredCount = 0;
		let proposedCount = 0;
		let unchangedCount = 0;
		const transfer = async (op: EditOp, sourceValue: EditValue | undefined, targetValue: EditValue | undefined): Promise<void> => {
			if (sourceValue === undefined) {
				return;
			}
			if (targetValue === undefined) {
				await this.interpretationService.edit(targetAnchor, op, sourceValue, author);
				transferredCount++;
				return;
			}
			if (sameEditValue(sourceValue, targetValue)) {
				unchangedCount++;
				return;
			}
			const alreadyProposed = this.interpretationService.pendingProposals(contentHash).some(proposal =>
				proposal.anchor.rva === targetAnchor.rva
				&& proposal.op === op
				&& proposal.author.kind === author.kind
				&& proposal.author.id === author.id
				&& sameEditValue(proposal.value, sourceValue));
			if (alreadyProposed) {
				unchangedCount++;
				return;
			}
			await this.interpretationService.propose(targetAnchor, op, sourceValue, author);
			proposedCount++;
		};
		const target = this.interpretationService.at(targetAnchor);
		await transfer(EditOp.Rename, source.name, target?.name);
		await transfer(EditOp.Comment, source.comment, target?.comment);
		await transfer(EditOp.Tags, source.tags, target?.tags);
		return { transferredCount, proposedCount, unchangedCount };
	}

	projectPath(contentHash: string): string | undefined {
		return this.active?.contentHash === contentHash ? this.active.handle.path : undefined;
	}

	projectSnapshot(contentHash: string): IDelverProjectSnapshot | undefined {
		return this.active?.contentHash === contentHash ? this.active.snapshot : undefined;
	}

	private async snapshotFor(session: IDelverProjectSession): Promise<IDelverProjectSnapshotUpdate> {
		if (!session.sessionId) {
			const snapshot = this.projectSnapshot(session.contentHash);
			if (!snapshot) {
				throw new Error('The project has no live target or saved snapshot.');
			}
			return snapshot;
		}
		const [imageInfo, functions, imports, exports, strings] = await Promise.all([
			this.analysisService.imageInfo(session.sessionId),
			this.analysisService.functions(session.sessionId),
			this.analysisService.imports(session.sessionId),
			this.analysisService.exports(session.sessionId),
			this.analysisService.strings(session.sessionId),
		]);
		return {
			imageInfo: JSON.stringify(imageInfo),
			functions: JSON.stringify(functions),
			imports: JSON.stringify(imports),
			exports: JSON.stringify(exports),
			strings: JSON.stringify(strings),
			decompiledFunctions: [...(this.pendingDecompilations.get(session.contentHash)?.values() ?? [])],
		};
	}

	private async migrateFunctionInterpretations(sourceContentHash: string, targetContentHash: string, matches: readonly IFunctionRevisionMatch[]): Promise<void> {
		const author = { kind: 'import' as const, id: `revision:${sourceContentHash}` };
		for (const match of matches) {
			const sourceRva = BigInt(match.source.rva);
			const targetRva = BigInt(match.target.rva);
			const source = this.interpretationService.at({ kind: 'image', contentHash: sourceContentHash, rva: sourceRva });
			if (!source) {
				continue;
			}
			const targetAnchor = { kind: 'image' as const, contentHash: targetContentHash, rva: targetRva };
			const target = this.interpretationService.at(targetAnchor);
			if (source.name !== undefined && target?.name === undefined) {
				await this.interpretationService.edit(targetAnchor, EditOp.Rename, source.name, author);
			}
			if (source.comment !== undefined && target?.comment === undefined) {
				await this.interpretationService.edit(targetAnchor, EditOp.Comment, source.comment, author);
			}
			if (source.tags !== undefined && target?.tags === undefined) {
				await this.interpretationService.edit(targetAnchor, EditOp.Tags, source.tags, author);
			}
		}
	}
}

registerSingleton(IDelverProjectService, DelverProjectService, InstantiationType.Delayed);

function compareSignatureNames(left: IDelverNamedSignature, right: IDelverNamedSignature): number {
	const leftName = left.name.toLowerCase();
	const rightName = right.name.toLowerCase();
	return leftName < rightName ? -1 : leftName > rightName ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeProjectRva(rva: string): string {
	try {
		return `0x${BigInt(rva).toString(16)}`;
	} catch {
		return rva;
	}
}

function sameEditValue(left: EditValue, right: EditValue): boolean {
	if (typeof left === 'string' || typeof right === 'string') {
		return left === right;
	}
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSignatureSearchProof(resultJson: string, pattern: string, targetRva: string): void {
	const result = projectRecord(JSON.parse(resultJson));
	const data = projectRecord(result.data);
	const matches = data.matches;
	if (result.completeness !== 'complete'
		|| typeof data.pattern !== 'string'
		|| data.pattern.toUpperCase() !== pattern.toUpperCase()
		|| !Array.isArray(matches)
		|| matches.length !== 1) {
		throw new Error('Signature migration byte-search proof is not an exact unique match');
	}
	const match = projectRecord(matches[0]);
	if (typeof match.rva !== 'string' || normalizeProjectRva(match.rva) !== normalizeProjectRva(targetRva)) {
		throw new Error('Signature migration byte-search proof points to a different function');
	}
}

function validateSignatureGenerationProof(
	resultJson: string,
	sourceRevisionId: string,
	sourceSignatureId: string,
	pattern: string,
	targetRva: string,
): void {
	const result = projectRecord(JSON.parse(resultJson));
	const data = projectRecord(result.data);
	const target = projectRecord(data.target);
	const proof = projectRecord(data.proof);
	const crossRevisionProof = projectRecord(data.crossRevisionProof);
	const selectedEvidence = projectRecord(crossRevisionProof.selectedEvidence);
	const revisions = crossRevisionProof.revisions;
	if (result.completeness !== 'complete'
		|| data.policy !== 'cross-revision-stable'
		|| typeof data.pattern !== 'string'
		|| data.pattern.toUpperCase() !== pattern.toUpperCase()
		|| typeof target.rva !== 'string'
		|| normalizeProjectRva(target.rva) !== normalizeProjectRva(targetRva)
		|| proof.unique !== true
		|| proof.matchCountExact !== true
		|| proof.matchCount !== 1
		|| proof.targetMatched !== true
		|| crossRevisionProof.method !== 'retained-exact-primary-signatures'
		|| selectedEvidence.sourceRevisionId !== sourceRevisionId
		|| selectedEvidence.sourceSignatureId !== sourceSignatureId
		|| !Array.isArray(revisions)
		|| !Number.isSafeInteger(crossRevisionProof.revisionCount)
		|| crossRevisionProof.revisionCount !== revisions.length) {
		throw new Error('Signature migration generation proof is not an exact bound cross-revision match');
	}
	const source = revisions.find(candidate => {
		const revision = projectRecord(candidate);
		return revision.revisionId === sourceRevisionId && revision.signatureId === sourceSignatureId;
	});
	if (source === undefined) {
		throw new Error('Signature migration generation proof does not cite the selected earlier signature');
	}
	const sourceRecord = projectRecord(source);
	if (typeof sourceRecord.pattern !== 'string' || sourceRecord.pattern.toUpperCase() !== pattern.toUpperCase()) {
		throw new Error('Signature migration generation proof contains a different earlier pattern');
	}
}

function projectRecord(value: unknown): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Signature migration evidence is malformed');
	}
	return value as Readonly<Record<string, unknown>>;
}

function fingerprintedFunctions(serialized: string | undefined): readonly IFingerprintedFunction[] {
	if (!serialized) {
		return [];
	}
	const result = JSON.parse(serialized) as IFunctionsResult;
	return result.functions.flatMap(functionValue => functionValue.fingerprint
		? [{ function: functionValue, fingerprint: functionValue.fingerprint }]
		: []);
}
