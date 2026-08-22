/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AnalysisSessionId, IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IFingerprintedFunction, IFunctionRevisionMatch, matchFunctionRevisions } from '../../../../platform/delver/common/functionRevisionMatcher.js';
import { IDelverProjectDecompilation, IDelverProjectHandle, IDelverProjectSnapshot, IDelverProjectSnapshotUpdate, IDelverProjectStoreService } from '../../../../platform/delver/common/delverProjectStoreService.js';
import { editToWire } from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { EditOp } from '../../../../platform/delver/common/interpretation.js';
import { IFunctionsResult } from '../../../../platform/delver/common/protocol.generated.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';

export const IDelverProjectService = createDecorator<IDelverProjectService>('delverProjectService');

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

/** Coordinates the active portable project and its incremental snapshots. */
export interface IDelverProjectService {
	readonly _serviceBrand: undefined;

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

	/** Path of the named project for these bytes, when the session is no longer untitled. */
	projectPath(contentHash: string): string | undefined;

	/** Snapshot for the active named project, when it was opened or saved. */
	projectSnapshot(contentHash: string): IDelverProjectSnapshot | undefined;
}

/** Renderer coordinator for the shared-process SQLite project store. */
export class DelverProjectService extends Disposable implements IDelverProjectService {
	readonly _serviceBrand: undefined;

	private active: { readonly contentHash: string; readonly revisionId: string; readonly handle: IDelverProjectHandle; snapshot?: IDelverProjectSnapshot } | undefined;
	private readonly pendingDecompilations = new Map<string, Map<string, IDelverProjectDecompilation>>();

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

function fingerprintedFunctions(serialized: string | undefined): readonly IFingerprintedFunction[] {
	if (!serialized) {
		return [];
	}
	const result = JSON.parse(serialized) as IFunctionsResult;
	return result.functions.flatMap(functionValue => functionValue.fingerprint
		? [{ function: functionValue, fingerprint: functionValue.fingerprint }]
		: []);
}
