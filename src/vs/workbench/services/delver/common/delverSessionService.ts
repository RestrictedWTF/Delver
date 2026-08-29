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
import { FunctionCorrectionKindWire, IFunctionsResult, IGetExportsResult, IGetImageInfoResult, IGetImportsResult, IOpenImageResult, IScanStringsResult, ISetCorrectionsResult, IStringsResult } from '../../../../platform/delver/common/protocol.generated.js';
import { isContentHash } from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDelverInterpretationService } from './delverInterpretationService.js';
import { EditOp, EditStatus, IEdit } from '../../../../platform/delver/common/interpretation.js';
import { authoredCorrectionsFor } from './delverFunctionCorrections.js';
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

	/**
	 * Fires when an open image's facts have been derived again.
	 *
	 * The session is the same one; its instructions, functions, blocks and
	 * cross-references are not. A view holding any of those is showing the
	 * previous derivation until it reacts, and nothing else announces this —
	 * `onDidChangeActiveSession` does not fire, because the session did not
	 * change.
	 */
	readonly onDidRederiveFacts: Event<IDelverSession>;

	/**
	 * Fires when the analysis server refused the accepted correction set.
	 *
	 * A correction set applies whole or not at all, so one correction that
	 * conflicts with another leaves *every* correction unapplied. The review
	 * queue still shows both accepted, and every fact read afterwards is
	 * derived from the previous seeds — which is the worst shape a failure can
	 * take here, because nothing looks wrong. It has to be said out loud.
	 */
	readonly onDidRefuseCorrections: Event<{ readonly session: IDelverSession; readonly reason: string }>;
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

	/**
	 * Re-scans a bounded window of the image for strings.
	 *
	 * Live only, and deliberately: the retained list is what an offline project
	 * has, and without the bytes there is nothing to scan. A project opened
	 * without its sample keeps whatever the cap left it, and says so.
	 */
	scanStrings(fromRva: string, maxStrings: number): Promise<IScanStringsResult>;

	/**
	 * Re-derives every fact for the open image from its bytes and current
	 * corrections.
	 *
	 * Nothing about the correction set has to have changed. Analysis is a
	 * function of bytes plus seeds, so a re-derivation with the same seeds is
	 * the same answer — which is exactly what makes this useful: it is the only
	 * way to say "compute that again" without authoring a correction to force
	 * it, and it is how a caller confirms that what it is reading is current.
	 *
	 * Live only. An offline project has facts and no bytes to re-derive them
	 * from.
	 */
	reanalyze(): Promise<ISetCorrectionsResult>;

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
	/**
	 * Sessions that currently have a correction set in effect.
	 *
	 * Kept so a withdrawal is still pushed: going from one correction to none is
	 * a change the server has to be told about, and an empty set is
	 * indistinguishable from "never corrected" without this.
	 */
	private readonly correctedSessions = new Set<AnalysisSessionId>();
	/**
	 * Sessions whose facts have been derived again since the snapshot was read.
	 *
	 * The saved snapshot is refreshed by a save and by nothing else, so after a
	 * re-derivation it holds the function list, image counts, and strings of
	 * whatever the last save saw. Answering from it would report the state of a
	 * save that predates the correction the analyst just accepted — and report
	 * it as current.
	 */
	private readonly rederivedSessions = new Set<AnalysisSessionId>();
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<IDelverSession | undefined>());
	readonly onDidChangeActiveSession = this._onDidChangeActiveSession.event;
	private readonly _onDidRederiveFacts = this._register(new Emitter<IDelverSession>());
	readonly onDidRederiveFacts = this._onDidRederiveFacts.event;
	private readonly _onDidRefuseCorrections = this._register(new Emitter<{ readonly session: IDelverSession; readonly reason: string }>());
	readonly onDidRefuseCorrections = this._onDidRefuseCorrections.event;

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
		// Joined, not fired and forgotten: the provider pairs live in the shared
		// process, which survives a reload. A release that races window teardown
		// leaves them attached with the sample mapped — on Windows that locks
		// the file the analyst is trying to rebuild.
		this._register(lifecycleService.onWillShutdown(event => event.join(
			this.releaseAllTargets(),
			{ id: 'join.delverTargets', label: localize('join.delverTargets', "Closing the analysis targets") },
		)));
		this._register(this.interpretationService.onDidChange(event => this.reapplyCorrections(event.edit)));
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
		// Serialized with every other open: locating a target starts a provider
		// pair exactly like opening one does, and a pair started against a
		// session that an interleaved open has already replaced is a leak.
		const result = this.opening.then(() => this.doAttach(targetPath), () => this.doAttach(targetPath));
		this.opening = result.then(session => session, () => undefined);
		return result;
	}

	private async doAttach(targetPath: string): Promise<IDelverSession> {
		const existing = this.activeSession;
		if (!existing?.projectPath) {
			throw new Error('Open a Delver project before locating its target.');
		}
		const candidate = await this.createSession(targetPath);
		try {
			if (candidate.contentHash !== existing.contentHash) {
				throw new Error('The selected target does not match this project revision (SHA-256 differs).');
			}
			// The entry is looked up again because `createSession` awaited: the
			// project this attach was meant for may have been closed meanwhile,
			// and there is then nothing to install the candidate into.
			const entry = this.activeEntry;
			if (!entry || entry.session !== existing) {
				throw new Error('The project this target was located for is no longer open.');
			}
			const attached: IDelverSession = { ...candidate, projectPath: existing.projectPath };
			const previousKey = this._activeTargetPath;
			if (previousKey === undefined) {
				throw new Error('The project this target was located for is no longer open.');
			}
			this.sessions.delete(previousKey);
			entry.session = attached;
			this.sessions.set(attached.targetPath, entry);
			this._activeTargetPath = attached.targetPath;
			this.targetAttachedContext.set(true);
			this._onDidChangeActiveSession.fire(attached);
			return attached;
		} catch (error) {
			// Every path that does not install the candidate releases it —
			// otherwise its provider pair outlives the request that made it.
			this.correctedSessions.delete(candidate.sessionId);
			this.rederivedSessions.delete(candidate.sessionId);
			await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
			throw error;
		}
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
				this.correctedSessions.delete(candidate.sessionId);
				this.rederivedSessions.delete(candidate.sessionId);
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
			// Already inside the open queue — going through `attachTarget` here
			// would wait on the very promise this call is part of.
			return this.doAttach(targetPath);
		}

		const candidate = await this.createSession(targetPath);
		if (candidate.contentHash === existing.contentHash) {
			this.correctedSessions.delete(candidate.sessionId);
			this.rederivedSessions.delete(candidate.sessionId);
			await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
			return existing;
		}

		if (!this.projectService.projectPath(existing.contentHash)) {
			if (!await this.confirmProjectClose(this.sessions.get(existing.targetPath))) {
				this.correctedSessions.delete(candidate.sessionId);
				this.rederivedSessions.delete(candidate.sessionId);
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
					this.correctedSessions.delete(candidate.sessionId);
					this.rederivedSessions.delete(candidate.sessionId);
			await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
					throw new CancellationError();
				}
				await this.analysisService.closeImage(existing.sessionId).catch(() => undefined);
				this.adoptSession(candidate, false);
				return candidate;
			case UpdatedTargetDecision.CreateProject:
				if (!await this.projectService.createProject(candidate)) {
					this.correctedSessions.delete(candidate.sessionId);
					this.rederivedSessions.delete(candidate.sessionId);
			await this.analysisService.closeImage(candidate.sessionId).catch(() => undefined);
					throw new CancellationError();
				}
				await this.analysisService.closeImage(existing.sessionId).catch(() => undefined);
				this.adoptSession(candidate, false);
				return candidate;
			default:
				this.correctedSessions.delete(candidate.sessionId);
				this.rederivedSessions.delete(candidate.sessionId);
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
			// Applied before the session is handed out, so no caller ever sees the
			// uncorrected facts of an image the analyst has already corrected.
			// Loading the log first is what makes the corrections available at all.
			await this.applyFunctionCorrections(handle.sessionId, contentHash);
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

	/**
	 * Re-derives an open image against the accepted corrections for its bytes.
	 *
	 * Pushed rather than pulled, because these facts live in the analysis server:
	 * a correction that only the renderer knew about would leave every xref,
	 * block, and call graph computed as though it had not been made
	 * ([ADR 0015](../../../../../../Docs/history/adr/0015-authored-corrections-re-derive-facts.md)).
	 *
	 * An empty set is still sent when one was previously in effect — that is how
	 * a withdrawal takes effect — but never for an image that has never had one,
	 * since a re-analysis that changes nothing is pure cost.
	 */
	/**
	 * Re-derives every open session whose bytes an accepted correction changed.
	 *
	 * Without this a correction takes effect only on the next open: the analyst
	 * accepts it, the disclosure says what it did, and every fact they then read
	 * is still derived from the uncorrected seeds. A proposal changes nothing, so
	 * only an accepted edit re-derives — re-analysing on a proposal would spend a
	 * full pass to arrive at the same facts.
	 */
	private reapplyCorrections(edit: IEdit): void {
		if (edit.op !== EditOp.FunctionBounds || edit.status !== EditStatus.Accepted || edit.anchor.kind !== 'image') {
			return;
		}
		for (const entry of this.sessions.values()) {
			const session = entry.session;
			if (session.contentHash !== edit.anchor.contentHash || session.sessionId === undefined) {
				continue;
			}
			// Deliberately not awaited: this is a reaction to an authored edit,
			// not a step in the caller's operation. The failure is *not*
			// swallowed, though. A refused set leaves the facts as they were
			// while the review queue shows the correction accepted, so an
			// analyst who is told nothing reads uncorrected facts believing
			// they are corrected — the false-claim failure, arrived at through
			// silence.
			void this.applyFunctionCorrections(session.sessionId, session.contentHash)
				.catch(error => this._onDidRefuseCorrections.fire({
					session,
					reason: error instanceof Error ? error.message : String(error),
				}));
		}
	}

	private async applyFunctionCorrections(sessionId: AnalysisSessionId, contentHash: string): Promise<void> {
		const { functions, dataRanges } = authoredCorrectionsFor(this.interpretationService, contentHash);
		const authored = functions.length + dataRanges.length;
		if (authored === 0 && !this.correctedSessions.has(sessionId)) {
			return;
		}
		await this.analysisService.setCorrections(
			sessionId,
			functions.map(correction => ({
				rva: correction.rva,
				kind: correction.kind === 'define' ? FunctionCorrectionKindWire.Define : FunctionCorrectionKindWire.Undefine,
				...(correction.endRva === undefined ? {} : { end_rva: correction.endRva }),
			})),
			dataRanges.map(range => ({ rva: range.rva, end_rva: range.endRva })),
		);
		// Recorded only once the server has accepted the set. Marking the
		// session corrected before the await left it bookkept as corrected
		// while the server held nothing of the sort, and the next empty set
		// would then be skipped as a no-op.
		if (authored === 0) {
			this.correctedSessions.delete(sessionId);
		} else {
			this.correctedSessions.add(sessionId);
		}
		this.rederivedSessions.add(sessionId);
		// Announced only after the server has actually re-derived. A view that
		// refreshed on the request rather than the result would read the
		// previous facts back and cache them as the new ones.
		const derived = [...this.sessions.values()].find(entry => entry.session.sessionId === sessionId)?.session;
		if (derived) {
			this._onDidRederiveFacts.fire(derived);
		}
	}

	private adoptSession(session: IDelverSession, dirty: boolean): void {
		const projectPath = this.projectService.projectPath(session.contentHash);
		const adopted = projectPath === undefined ? session : { ...session, projectPath };
		this.sessions.set(adopted.targetPath, {
			session: adopted,
			isProjectDirty: dirty,
			projectPath,
		});
		this._activeTargetPath = adopted.targetPath;
		this.publishActive(adopted);
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
				this.adoptProjectPath(entry, projectPath);
			}
		}
	}

	/**
	 * Records where one entry's project now lives, session included.
	 *
	 * The session carries the path the panes and the agent read, so moving the
	 * entry alone leaves a Save As reporting — and re-saving — the old project.
	 */
	private adoptProjectPath(entry: IDelverSessionEntry, projectPath: string | undefined): void {
		if (entry.projectPath === projectPath && entry.session.projectPath === projectPath) {
			return;
		}
		entry.projectPath = projectPath;
		entry.session = { ...entry.session, projectPath };
		if (entry === this.activeEntry) {
			this.publishActive(entry.session);
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
		this.adoptProjectPath(entry, this.projectService.projectPath(entry.session.contentHash));
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

	async scanStrings(fromRva: string, maxStrings: number): Promise<IScanStringsResult> {
		const session = this.activeSession;
		if (!session) {
			throw new Error('No Delver project is open.');
		}
		if (session.sessionId === undefined) {
			throw new Error('This project is open without its original sample, so strings past the retained list cannot be scanned. Ask the analyst to locate the matching target.');
		}
		return this.analysisService.scanStrings(session.sessionId, fromRva, maxStrings);
	}

	async reanalyze(): Promise<ISetCorrectionsResult> {
		const session = this.activeSession;
		if (!session) {
			throw new Error('No Delver project is open.');
		}
		if (session.sessionId === undefined) {
			throw new Error('This project is open without its original sample, so its facts cannot be re-derived. Ask the analyst to locate the matching target.');
		}
		const { functions, dataRanges } = authoredCorrectionsFor(this.interpretationService, session.contentHash);
		// Deliberately unconditional, where `applyFunctionCorrections` returns
		// early on an empty set. That early return is a cost optimisation for a
		// push nobody asked for; this is a caller asking, and answering "there
		// was nothing to do" would be answering a different question.
		const result = await this.analysisService.setCorrections(
			session.sessionId,
			functions.map(correction => ({
				rva: correction.rva,
				kind: correction.kind === 'define' ? FunctionCorrectionKindWire.Define : FunctionCorrectionKindWire.Undefine,
				...(correction.endRva === undefined ? {} : { end_rva: correction.endRva }),
			})),
			dataRanges.map(range => ({ rva: range.rva, end_rva: range.endRva })),
		);
		if (functions.length + dataRanges.length > 0) {
			this.correctedSessions.add(session.sessionId);
		} else {
			this.correctedSessions.delete(session.sessionId);
		}
		this.rederivedSessions.add(session.sessionId);
		this._onDidRederiveFacts.fire(session);
		return result;
	}

	strings(): Promise<IStringsResult> {
		return this.readSnapshotOrLive('strings', value => JSON.parse(value) as IStringsResult);
	}

	private readSnapshotOrLive<T>(category: 'imageInfo' | 'functions' | 'imports' | 'exports' | 'strings', parse: (value: string) => T): Promise<T> {
		const session = this.activeSession;
		if (!session) {
			return Promise.reject(new Error('No Delver project is open.'));
		}
		// A re-derivation supersedes the snapshot for every derived category
		// below, and the sample is right there, so ask it rather than repeat a
		// stale answer. The snapshot is still the only source for a project
		// opened without its sample, which is why this is conditional on having
		// one.
		const stale = session.sessionId !== undefined && this.rederivedSessions.has(session.sessionId);
		const serialized = stale ? undefined : this.projectService.projectSnapshot(session.contentHash)?.[category];
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
