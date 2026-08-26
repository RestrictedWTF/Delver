/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extname, isAbsolute, normalize } from '../../../../base/common/path.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import {
	AnalysisSessionId,
	IDelverAnalysisService,
} from '../../../../platform/delver/common/delverAnalysisService.js';
import { IFunctionsResult, IGetExportsResult, IGetImageInfoResult, IGetImportsResult, IOpenImageResult, IStringsResult } from '../../../../platform/delver/common/protocol.generated.js';
import { isContentHash } from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';
import { IDelverProjectService } from './delverProjectService.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';

export const IDelverSessionService = createDecorator<IDelverSessionService>('delverSessionService');

/**
 * True while a target is open.
 *
 * Views need this to tell "nothing is open" from "this image has none of those".
 * An empty Exports pane saying "No target open" while a target is plainly open
 * is not a cosmetic problem — it reports the tool's state wrongly, and the
 * honest answer, that the binary exports nothing, is a real finding.
 */
export const DELVER_TARGET_OPEN = new RawContextKey<boolean>('delverTargetOpen', false);
export const DELVER_TARGET_ATTACHED = new RawContextKey<boolean>('delverTargetAttached', false);

/** An analysis session that some editor is currently holding open. */
export interface IDelverSession {
	/** Present only while the original sample is attached to a live provider. */
	readonly sessionId?: AnalysisSessionId;
	readonly targetPath: string;
	readonly image?: IOpenImageResult;
	readonly projectPath?: string;
	/**
	 * SHA-256 of the image's file bytes, lowercase hex.
	 *
	 * The identity interpretation anchors to. It is carried on the session
	 * because every pane that wants to show an authored name needs it, and it
	 * must not be re-derived per pane.
	 */
	readonly contentHash: string;
}

/**
 * Owns the analysis session for the target the workbench has open.
 *
 * **The session belongs to the target, not to an editor.** It used to be owned
 * by whichever editor opened it, which meant switching from the listing to the
 * strings tab evicted the listing, tore its session down, and left every pane
 * asking for a target that was still open. A session outlives any one view of
 * it, exactly as the open file does.
 */
export interface IDelverSessionService {
	readonly _serviceBrand: undefined;

	readonly activeSession: IDelverSession | undefined;
	readonly onDidChangeActiveSession: Event<IDelverSession | undefined>;
	readonly isProjectDirty: boolean;
	readonly projectPath: string | undefined;

	/**
	 * Opens `targetPath` for analysis, replacing whatever was open.
	 *
	 * Returns the existing session unchanged when the same target is already
	 * open, so switching between the listing and strings tabs costs nothing.
	 */
	openTarget(targetPath: string): Promise<IDelverSession>;

	/** Opens a portable project and attaches its hash-matching target when the saved path is inside the workspace. */
	openProject(projectPath: string): Promise<IDelverSession>;

	/** Attaches matching bytes to an offline project. The active project is unchanged on mismatch. */
	attachTarget(targetPath: string): Promise<IDelverSession>;

	/**
	 * Re-reads an explicitly selected target even when its path is already open.
	 * Normal pane restoration must use {@link openTarget} so it remains free.
	 */
	refreshTarget(targetPath: string): Promise<IDelverSession>;

	imageInfo(): Promise<IGetImageInfoResult>;
	functions(): Promise<IFunctionsResult>;
	imports(): Promise<IGetImportsResult>;
	exports(): Promise<IGetExportsResult>;
	strings(): Promise<IStringsResult>;

	/** Marks newly produced or edited analysis as requiring persistence. */
	markProjectDirty(): void;

	/** Marks the current project as persisted, optionally remembering its path. */
	markProjectSaved(projectPath?: string): void;

	/** Saves the active analysis to its current project or prompts for a project path. */
	saveProject(): Promise<boolean>;

	/** Closes one open target, or the active one. False when the user cancels. */
	closeTarget(targetPath?: string): Promise<boolean>;

	/**
	 * Points the implicit API at an already-open target.
	 *
	 * Called by a workspace editor when it becomes visible, so `functions()` and
	 * friends answer for the target on screen rather than the one opened last.
	 */
	setActiveTarget(targetPath: string): void;
}

type IDelverLiveSession = IDelverSession & Required<Pick<IDelverSession, 'sessionId' | 'image'>>;

const enum ProjectCloseDecision {
	Save = 'save',
	Discard = 'discard',
	Cancel = 'cancel',
}

/** One open target: its session, plus the project state that belongs to it. */
interface IDelverSessionEntry {
	session: IDelverSession;
	isProjectDirty: boolean;
	projectPath: string | undefined;
}

const enum UpdatedTargetDecision {
	AddRevision = 'addRevision',
	CreateProject = 'createProject',
	Cancel = 'cancel',
}

export class DelverSessionService extends Disposable implements IDelverSessionService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IDelverSession | undefined>());
	readonly onDidChangeActiveSession = this._onDidChangeActiveSession.event;

	/**
	 * Every open target, keyed by its path.
	 *
	 * Dirty state and project path live here with the session rather than on the
	 * service, because they describe *a* project, not the service. See ADR 0008.
	 */
	private readonly sessions = new Map<string, IDelverSessionEntry>();

	/** Which open target the implicit API answers for; follows the focused workspace. */
	private _activeTargetPath: string | undefined;

	/** Tail of in-flight opens, so concurrent requests cannot race. */
	private opening: Promise<IDelverSession | undefined> = Promise.resolve(undefined);

	private get activeEntry(): IDelverSessionEntry | undefined {
		return this._activeTargetPath === undefined ? undefined : this.sessions.get(this._activeTargetPath);
	}

	get activeSession(): IDelverSession | undefined {
		return this.activeEntry?.session;
	}

	get isProjectDirty(): boolean {
		return this.activeEntry?.isProjectDirty ?? false;
	}

	get projectPath(): string | undefined {
		return this.activeEntry?.projectPath;
	}

	private readonly targetOpenContext: IContextKey<boolean>;
	private readonly targetAttachedContext: IContextKey<boolean>;

	constructor(
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IDelverProjectService private readonly projectService: IDelverProjectService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.targetOpenContext = DELVER_TARGET_OPEN.bindTo(contextKeyService);
		this.targetAttachedContext = DELVER_TARGET_ATTACHED.bindTo(contextKeyService);
		this._register(lifecycleService.onBeforeShutdown(event => {
			event.veto(this.shouldVetoShutdown(), 'veto.delverUnsavedProject');
		}));
		this._register({ dispose: () => { void this.releaseAllTargets(); } });
	}

	async openTarget(targetPath: string): Promise<IDelverSession> {
		if (extname(targetPath).toLowerCase() === '.delverdb') {
			return this.openProject(targetPath);
		}
		const existing = this.activeSession;
		if (existing?.targetPath === targetPath) {
			return existing;
		}

		// Serialized: two editors restoring at once must not each start a
		// provider pair for the same file.
		const result = this.opening.then(() => this.doOpen(targetPath), () => this.doOpen(targetPath));
		// A failed open must not poison the queue for the next target.
		this.opening = result.then(session => session, () => undefined);
		return result;
	}

	async attachTarget(targetPath: string): Promise<IDelverSession> {
		const existing = this.activeSession;
		if (!existing?.projectPath) {
			throw new Error('Open a Delver project before locating its target.');
		}
		const candidate = await this.createSession(targetPath);
		if (candidate.contentHash !== existing.contentHash) {
			await this.analysisService.closeImage(candidate.sessionId!).catch(() => undefined);
			throw new Error('The selected target does not match this project revision (SHA-256 differs).');
		}
		const attached: IDelverSession = { ...candidate, projectPath: existing.projectPath };
		const entry = this.activeEntry;
		if (entry) {
			entry.session = attached;
		}
		this.targetAttachedContext.set(true);
		this._onDidChangeActiveSession.fire(attached);
		return attached;
	}

	async openProject(projectPath: string): Promise<IDelverSession> {
		const existing = this.activeSession;
		if (existing?.projectPath === projectPath) {
			return existing;
		}
		const result = this.opening.then(() => this.doOpenProject(projectPath), () => this.doOpenProject(projectPath));
		this.opening = result.then(session => session, () => undefined);
		return result;
	}

	private async doOpenProject(projectPath: string): Promise<IDelverSession> {
		if (!await this.closeTarget()) {
			throw new CancellationError();
		}
		const project = await this.projectService.openProject(projectPath);
		const offlineSession: IDelverSession = {
			targetPath: project.sourcePath ?? project.path,
			projectPath: project.path,
			contentHash: project.contentHash,
		};
		const session = await this.tryAttachSavedWorkspaceTarget(project.sourcePath, offlineSession);
		this.adoptSession(session, false);
		return session;
	}

	private async tryAttachSavedWorkspaceTarget(sourcePath: string | undefined, offlineSession: IDelverSession): Promise<IDelverSession> {
		if (!sourcePath || !isAbsolute(sourcePath)) {
			return offlineSession;
		}
		const targetPath = normalize(sourcePath);
		if (!this.workspaceContextService.getWorkspaceFolder(URI.file(targetPath))) {
			return offlineSession;
		}
		try {
			const candidate = await this.createSession(targetPath, false);
			if (candidate.contentHash !== offlineSession.contentHash) {
				await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
				return offlineSession;
			}
			return { ...candidate, projectPath: offlineSession.projectPath };
		} catch {
			return offlineSession;
		}
	}

	async refreshTarget(targetPath: string): Promise<IDelverSession> {
		const existing = this.activeSession;
		if (!existing || existing.targetPath !== targetPath) {
			return this.openTarget(targetPath);
		}

		const result = this.opening.then(() => this.doRefresh(targetPath), () => this.doRefresh(targetPath));
		this.opening = result.then(session => session, () => undefined);
		return result;
	}

	private async doOpen(targetPath: string): Promise<IDelverSession> {
		// Already open — including in another workspace — so adopt it rather than
		// analysing the same bytes twice.
		const open = this.sessions.get(targetPath);
		if (open) {
			this._activeTargetPath = targetPath;
			this.publishActive(open.session);
			return open.session;
		}

		// Deliberately does *not* close the previous target. Sessions are
		// per-target now (ADR 0008); evicting one here is what made a second
		// workspace show the first one's binary.
		const session = await this.createSession(targetPath);
		this.adoptSession(session, true);
		return session;
	}

	private async doRefresh(targetPath: string): Promise<IDelverSession> {
		const existing = this.activeSession;
		if (!existing || existing.targetPath !== targetPath) {
			return this.doOpen(targetPath);
		}
		if (!existing.sessionId) {
			return this.attachTarget(targetPath);
		}

		const candidate = await this.createSession(targetPath);
		if (candidate.contentHash === existing.contentHash) {
			await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
			return existing;
		}

		if (!this.projectService.projectPath(existing.contentHash)) {
			if (!await this.confirmProjectClose(this.sessions.get(existing.targetPath))) {
				await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
				throw new CancellationError();
			}
			await this.releaseTarget();
			this.adoptSession(candidate, true);
			return candidate;
		}

		const decision = await this.confirmUpdatedTarget();
		switch (decision) {
			case UpdatedTargetDecision.AddRevision:
				if (!await this.projectService.addRevision(existing, candidate)) {
					await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
					throw new CancellationError();
				}
				await this.analysisService.closeImage(existing.sessionId).catch(() => undefined);
				this.adoptSession(candidate, false);
				return candidate;
			case UpdatedTargetDecision.CreateProject:
				if (!await this.projectService.createProject(candidate)) {
					await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
					throw new CancellationError();
				}
				await this.analysisService.closeImage(existing.sessionId).catch(() => undefined);
				this.adoptSession(candidate, false);
				return candidate;
			default:
				await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
				throw new CancellationError();
		}
	}

	private async createSession(targetPath: string, loadInterpretation = true): Promise<IDelverLiveSession> {
		const handle = await this.analysisService.openImage({ kind: 'file', path: targetPath });
		let contentHash: string;
		try {
			const info = await this.analysisService.imageInfo(handle.sessionId);
			if (!isContentHash(info.content_hash)) {
				throw new Error('The target provider did not return a valid content hash. Rebuild or update provider-file.');
			}
			contentHash = info.content_hash;
			if (loadInterpretation) {
				await this.interpretationService.load(contentHash);
			}
		} catch (error) {
			await this.analysisService.closeImage(handle.sessionId).catch(() => undefined);
			throw error;
		}
		return {
			sessionId: handle.sessionId,
			targetPath,
			image: handle.image,
			contentHash,
		};
	}

	private adoptSession(session: IDelverSession, dirty: boolean): void {
		this.sessions.set(session.targetPath, {
			session,
			isProjectDirty: dirty,
			projectPath: this.projectService.projectPath(session.contentHash),
		});
		this._activeTargetPath = session.targetPath;
		this.publishActive(session);
	}

	/**
	 * Points the implicit API at an already-open target.
	 *
	 * The workspace editor calls this when it becomes visible, so that
	 * `functions()`, `imports()` and the rest answer for the target the analyst
	 * is actually looking at rather than whichever was opened last (ADR 0008).
	 */
	setActiveTarget(targetPath: string): void {
		if (this._activeTargetPath === targetPath || !this.sessions.has(targetPath)) {
			return;
		}
		this._activeTargetPath = targetPath;
		this.publishActive(this.sessions.get(targetPath)!.session);
	}

	private publishActive(session: IDelverSession | undefined): void {
		this.targetOpenContext.set(session !== undefined);
		this.targetAttachedContext.set(session?.sessionId !== undefined);
		this._onDidChangeActiveSession.fire(session);
	}

	markProjectDirty(): void {
		const entry = this.activeEntry;
		if (entry) {
			entry.isProjectDirty = true;
		}
	}

	markProjectSaved(projectPath?: string): void {
		const entry = this.activeEntry;
		if (entry) {
			entry.isProjectDirty = false;
			if (projectPath !== undefined) {
				entry.projectPath = projectPath;
			}
		}
	}

	async saveProject(): Promise<boolean> {
		return this.saveEntry(this.activeEntry);
	}

	/** Saves one target's project, active or not — shutdown must save them all. */
	private async saveEntry(entry: IDelverSessionEntry | undefined): Promise<boolean> {
		if (!entry || !await this.projectService.save(entry.session)) {
			return false;
		}
		entry.isProjectDirty = false;
		entry.projectPath = this.projectService.projectPath(entry.session.contentHash);
		return true;
	}

	imageInfo(): Promise<IGetImageInfoResult> {
		return this.readSnapshotOrLive('imageInfo', value => JSON.parse(value) as IGetImageInfoResult);
	}

	functions(): Promise<IFunctionsResult> {
		return this.readSnapshotOrLive('functions', value => JSON.parse(value) as IFunctionsResult);
	}

	imports(): Promise<IGetImportsResult> {
		return this.readSnapshotOrLive('imports', value => JSON.parse(value) as IGetImportsResult);
	}

	exports(): Promise<IGetExportsResult> {
		return this.readSnapshotOrLive('exports', value => JSON.parse(value) as IGetExportsResult);
	}

	strings(): Promise<IStringsResult> {
		return this.readSnapshotOrLive('strings', value => JSON.parse(value) as IStringsResult);
	}

	private readSnapshotOrLive<T>(category: 'imageInfo' | 'functions' | 'imports' | 'exports' | 'strings', parse: (value: string) => T): Promise<T> {
		const session = this.activeSession;
		if (!session) {
			return Promise.reject(new Error('No Delver project is open.'));
		}
		const serialized = this.projectService.projectSnapshot(session.contentHash)?.[category];
		if (serialized !== undefined) {
			try {
				return Promise.resolve(parse(serialized));
			} catch (error) {
				return Promise.reject(new Error(`The saved ${category} snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`));
			}
		}
		if (!session.sessionId) {
			return Promise.reject(new Error(`The project has no saved ${category} snapshot. Locate the matching target to load it.`));
		}
		switch (category) {
			case 'imageInfo': return this.analysisService.imageInfo(session.sessionId) as Promise<T>;
			case 'functions': return this.analysisService.functions(session.sessionId) as Promise<T>;
			case 'imports': return this.analysisService.imports(session.sessionId) as Promise<T>;
			case 'exports': return this.analysisService.exports(session.sessionId) as Promise<T>;
			case 'strings': return this.analysisService.strings(session.sessionId) as Promise<T>;
		}
	}

	async closeTarget(targetPath?: string): Promise<boolean> {
		const key = targetPath ?? this._activeTargetPath;
		const entry = key === undefined ? undefined : this.sessions.get(key);
		if (!await this.confirmProjectClose(entry)) {
			return false;
		}
		await this.releaseTarget(key);
		return true;
	}

	private async shouldVetoShutdown(): Promise<boolean> {
		// Every open target, not just the focused one. A second workspace with
		// unsaved analysis must not be discarded silently because its tab
		// happened not to be in front.
		for (const entry of [...this.sessions.values()]) {
			if (!await this.confirmProjectClose(entry)) {
				return true;
			}
		}
		return false;
	}

	private async confirmProjectClose(entry: IDelverSessionEntry | undefined): Promise<boolean> {
		if (!entry || !entry.isProjectDirty) {
			return true;
		}
		const { result } = await this.dialogService.prompt<ProjectCloseDecision>({
			type: Severity.Warning,
			message: localize('delverSaveProjectMessage', "Do you want to save the changes to your Delver project?"),
			detail: localize('delverSaveProjectDetail', "The analysis for this target will be lost if you don't save it."),
			buttons: [
				{
					label: localize({ key: 'delverSaveProject', comment: ['&& denotes a mnemonic'] }, "&&Save"),
					run: () => ProjectCloseDecision.Save,
				},
				{
					label: localize({ key: 'delverDiscardProject', comment: ['&& denotes a mnemonic'] }, "Do&&n't Save"),
					run: () => ProjectCloseDecision.Discard,
				},
			],
			cancelButton: {
				label: localize('delverCancelProjectClose', "Cancel"),
				run: () => ProjectCloseDecision.Cancel,
			},
		});

		switch (result) {
			case ProjectCloseDecision.Save:
				if (!await this.saveEntry(entry)) {
					return false;
				}
				return true;
			case ProjectCloseDecision.Discard:
				entry.isProjectDirty = false;
				return true;
			default:
				return false;
		}
	}

	private async confirmUpdatedTarget(): Promise<UpdatedTargetDecision> {
		const { result } = await this.dialogService.prompt<UpdatedTargetDecision>({
			type: Severity.Warning,
			message: localize('delverUpdatedTargetMessage', "This binary has changed since the project was opened."),
			detail: localize('delverUpdatedTargetDetail', "Keep the existing analysis as a revision, or start a separate project for the updated binary."),
			buttons: [
				{
					label: localize({ key: 'delverAddTargetRevision', comment: ['&& denotes a mnemonic'] }, "&&Add as New Revision"),
					run: () => UpdatedTargetDecision.AddRevision,
				},
				{
					label: localize({ key: 'delverCreateTargetProject', comment: ['&& denotes a mnemonic'] }, "&&Create New Project"),
					run: () => UpdatedTargetDecision.CreateProject,
				},
			],
			cancelButton: {
				label: localize('delverCancelTargetUpdate', "Cancel"),
				run: () => UpdatedTargetDecision.Cancel,
			},
		});
		return result ?? UpdatedTargetDecision.Cancel;
	}

	/** Closes one open target, or the active one. */
	private async releaseTarget(targetPath?: string): Promise<void> {
		const key = targetPath ?? this._activeTargetPath;
		const entry = key === undefined ? undefined : this.sessions.get(key);
		if (!entry || key === undefined) {
			return;
		}
		this.sessions.delete(key);
		if (this._activeTargetPath === key) {
			// Hand the implicit API to whatever else is still open, so closing one
			// workspace does not leave every surface answering for nothing.
			const next = this.sessions.keys().next();
			this._activeTargetPath = next.done ? undefined : next.value;
			this.publishActive(this.activeSession);
		}
		await this.projectService.close(entry.session).catch(() => undefined);
		if (entry.session.sessionId) {
			await this.analysisService.closeImage(entry.session.sessionId).catch(() => undefined);
		}
	}

	/** Closes every open target. Used on shutdown. */
	private async releaseAllTargets(): Promise<void> {
		for (const key of [...this.sessions.keys()]) {
			await this.releaseTarget(key);
		}
	}
}

registerSingleton(IDelverSessionService, DelverSessionService, InstantiationType.Delayed);
