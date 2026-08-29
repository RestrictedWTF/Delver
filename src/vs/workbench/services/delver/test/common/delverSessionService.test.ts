/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IPrompt, IPromptResult, IPromptResultWithCancel, IPromptWithCustomCancel, IPromptWithDefaultCancel } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { DelverFindingOutcome, IDelverFinding, IDelverFindingDecision, IDelverFindingDraft } from '../../../../../platform/delver/common/findings.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IDataRangeCorrectionWire, IFunctionCorrectionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { Anchor, anchorKey, EditOp, EditStatus, IEdit, IInterpretationAt } from '../../../../../platform/delver/common/interpretation.js';
import { IDelverProjectSnapshot, IDelverRetainedXrefs } from '../../../../../platform/delver/common/delverProjectStoreService.js';
import { IDelverToolCallRecord } from '../../../../../platform/delver/common/delverToolCall.js';
import { IDelverNamedSignature, IDelverNamedSignatureDraft } from '../../../../../platform/delver/common/delverSignature.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import {
	DelverSessionService,
	IDelverSession,
	IDelverSessionService,
} from '../../common/delverSessionService.js';
import { IDelverHistoricalSignature, IDelverOpenedProject, IDelverProjectService } from '../../common/delverProjectService.js';
import { TestContextService, TestLifecycleService } from '../../../../test/common/workbenchTestServices.js';
import { ShutdownReason } from '../../../lifecycle/common/lifecycle.js';

/** Records opens and closes so lifetime can be asserted. */
class FakeAnalysisService implements Partial<IDelverAnalysisService> {
	readonly opened: string[] = [];
	readonly closed: string[] = [];
	contentHash: string | undefined = 'a'.repeat(64);
	readonly openErrors = new Set<string>();
	/** Correction sets pushed to the server, in the order they were applied. */
	readonly correctionSets: {
		readonly sessionId: string;
		readonly corrections: readonly IFunctionCorrectionWire[];
		readonly dataRanges: readonly IDataRangeCorrectionWire[];
	}[] = [];
	/** Held to stop an open mid-flight, when a pair exists but is not adopted. */
	openGate: DeferredPromise<void> | undefined;
	readonly openReachedGate = new DeferredPromise<void>();
	private next = 1;

	/** Set to make the server refuse the whole correction set, as it really does. */
	correctionRefusal: string | undefined;

	async setCorrections(
		sessionId: string,
		corrections: readonly IFunctionCorrectionWire[],
		dataRanges: readonly IDataRangeCorrectionWire[] = [],
	) {
		if (this.correctionRefusal !== undefined) {
			throw new Error(this.correctionRefusal);
		}
		this.correctionSets.push({ sessionId, corrections, dataRanges });
		return {
			image_id: sessionId,
			function_count_before: 0,
			function_count: corrections.length,
			instruction_count: 0,
			corrections_applied: corrections.length,
			data_ranges_applied: dataRanges.length,
			decoding: { kind: 'decoded' as const },
			generation: this.correctionSets.length,
		};
	}

	async openImage(config: { kind: 'file'; path: string }) {
		this.opened.push(config.path);
		if (this.openErrors.has(config.path)) {
			throw new Error('target unavailable');
		}
		if (this.openGate) {
			await this.openReachedGate.complete();
			await this.openGate.p;
		}
		return {
			sessionId: `session-${this.next++}`,
			image: {
				image_id: 'image-0',
				arch: 'X86_64',
				instruction_count: 10,
				function_count: 2,
				xref_count: 3,
				string_count: 4,
				strings_truncated: false,
				bytes_read: '0x1000',
				coverage_complete: true,
				decoding: { kind: 'decoded' as const },
				fully_parsed: true,
				unreadable_ranges: [],
			},
		};
	}

	async imageInfo(_sessionId: string) {
		return { content_hash: this.contentHash } as never;
	}

	async closeImage(sessionId: string) {
		this.closed.push(sessionId);
	}
}

class FakeInterpretationService implements Partial<IDelverInterpretationService> {
	readonly loaded: string[] = [];
	loadError: Error | undefined;

	/** Accepted corrections this image should be re-derived against. */
	readonly corrections = new Map<string, IEdit[]>();
	private readonly _onDidChange = new Emitter<{ readonly edit: IEdit }>();
	readonly onDidChange = this._onDidChange.event;

	/** Records an accepted edit and announces it, as the real service does. */
	accept(edit: IEdit): void {
		const log = this.corrections.get(edit.anchor.contentHash) ?? [];
		log.push(edit);
		this.corrections.set(edit.anchor.contentHash, log);
		this._onDidChange.fire({ edit });
	}

	async load(contentHash: string): Promise<void> {
		this.loaded.push(contentHash);
		if (this.loadError) {
			throw this.loadError;
		}
	}

	logFor(contentHash: string): readonly IEdit[] {
		return this.corrections.get(contentHash) ?? [];
	}

	at(anchor: Anchor): IInterpretationAt | undefined {
		const edit = this.logFor(anchor.contentHash).find(candidate => anchorKey(candidate.anchor) === anchorKey(anchor));
		return edit === undefined ? undefined : { functionBounds: String(edit.value) };
	}
}

class FakeProjectLifecycleDelegate implements IDelverProjectService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeFindings = Event.None;
	readonly onDidChangeSignatures = Event.None;
	readonly saved: string[] = [];
	saveResult = true;
	addRevisionResult = true;
	createProjectResult = true;
	projectPaths = new Map<string, string>();
	readonly revisions: { previous: string; updated: string }[] = [];
	openedProject: IDelverOpenedProject | undefined;

	async save(session: IDelverSession): Promise<boolean> {
		this.saved.push(session.targetPath);
		if (this.saveResult && !this.projectPaths.has(session.contentHash)) {
			this.projectPaths.set(session.contentHash, 'C:\\projects\\saved.delverdb');
		}
		return this.saveResult;
	}

	async close(): Promise<void> { }

	async addRevision(previous: IDelverSession, updated: IDelverSession): Promise<boolean> {
		this.revisions.push({ previous: previous.contentHash, updated: updated.contentHash });
		if (this.addRevisionResult) {
			const path = this.projectPaths.get(previous.contentHash);
			if (path) {
				this.projectPaths.set(updated.contentHash, path);
			}
		}
		return this.addRevisionResult;
	}

	async createProject(session: IDelverSession): Promise<boolean> {
		if (this.createProjectResult) {
			this.projectPaths.clear();
			this.projectPaths.set(session.contentHash, 'C:\\projects\\updated.delverdb');
		}
		return this.createProjectResult;
	}

	async openProject(): Promise<IDelverOpenedProject> {
		if (!this.openedProject) {
			throw new Error('not configured');
		}
		return this.openedProject;
	}

	async recordDecompilation(): Promise<void> { }
	async recordToolCall(): Promise<void> { }
	toolCallsFor(): readonly IDelverToolCallRecord[] { return []; }
	toolCall(): IDelverToolCallRecord | undefined { return undefined; }
	async saveSignature(_contentHash: string, _draft: IDelverNamedSignatureDraft): Promise<IDelverNamedSignature> { throw new Error('not implemented'); }
	async renameSignature(_contentHash: string, _signatureId: string, _name: string): Promise<IDelverNamedSignature> { throw new Error('not implemented'); }
	async deleteSignature(_contentHash: string, _signatureId: string): Promise<void> { }
	signaturesFor(): readonly IDelverNamedSignature[] { return []; }
	async historicalSignaturesFor(): Promise<readonly IDelverHistoricalSignature[]> { return []; }
	async acceptSignatureMigration(): Promise<{ transferredCount: number; proposedCount: number; unchangedCount: number }> {
		return { transferredCount: 0, proposedCount: 0, unchangedCount: 0 };
	}

	async reportFindings(_contentHash: string, _drafts: readonly IDelverFindingDraft[]): Promise<readonly IDelverFinding[]> { return []; }

	findingsFor(): readonly IDelverFinding[] { return []; }
	pendingFindings(): readonly IDelverFinding[] { return []; }
	async resolveFindings(_contentHash: string, _findingIds: readonly string[], _outcome: DelverFindingOutcome): Promise<readonly IDelverFindingDecision[]> { return []; }
	findingDecisionFor(): IDelverFindingDecision | undefined { return undefined; }
	findingDecisionsFor(): readonly IDelverFindingDecision[] { return []; }

	projectPath(contentHash: string): string | undefined { return this.projectPaths.get(contentHash); }

	projectSnapshot(contentHash: string): IDelverProjectSnapshot | undefined {
		return this.openedProject?.contentHash === contentHash ? this.openedProject.snapshot : undefined;
	}

	async retainedXrefs(): Promise<IDelverRetainedXrefs | undefined> { return undefined; }
	async hasRetainedXrefs(): Promise<boolean> { return false; }
}

class FakeDialogService extends TestDialogService {
	decision: 'save' | 'discard' | 'addRevision' | 'createProject' | 'cancel' = 'discard';
	prompts = 0;

	override prompt<T>(prompt: IPromptWithCustomCancel<T>): Promise<IPromptResultWithCancel<T>>;
	override prompt<T>(prompt: IPromptWithDefaultCancel<T>): Promise<IPromptResult<T>>;
	override prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;
	override async prompt<T>(_prompt: IPrompt<T>): Promise<IPromptResultWithCancel<T>> {
		this.prompts++;
		return { result: this.decision as T };
	}
}

function createService(store: Pick<ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>, 'add'>) {
	const analysis = new FakeAnalysisService();
	const interpretation = new FakeInterpretationService();
	const projectLifecycle = new FakeProjectLifecycleDelegate();
	const dialog = new FakeDialogService();
	const lifecycle = store.add(new TestLifecycleService());
	const service = store.add(new DelverSessionService(
		analysis as unknown as IDelverAnalysisService,
		interpretation as unknown as IDelverInterpretationService,
		projectLifecycle,
		dialog,
		lifecycle,
		new MockContextKeyService(),
		new TestContextService(testWorkspace(URI.file('C:\\workspace'))),
	));
	return { service, analysis, interpretation, projectLifecycle, dialog, lifecycle };
}

function openedProject(contentHash: string, sourcePath: string): IDelverOpenedProject {
	const snapshot: IDelverProjectSnapshot = {
		metadata: {
			schemaVersion: 6,
			currentRevisionId: contentHash,
			contentHash,
			displayName: 'sample.exe',
			sourcePath,
			createdAt: 1,
			updatedAt: 1,
		},
		interpretations: [],
		findings: [],
		findingDecisions: [],
		toolCalls: [],
		signatures: [],
	};
	return {
		path: 'C:\\workspace\\sample.delverdb',
		contentHash,
		displayName: 'sample.exe',
		sourcePath,
		snapshot,
	};
}

suite('DelverSessionService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered as a singleton', () => {
		assert.ok(
			getSingletonServiceDescriptors().some(([id]) => id === IDelverSessionService),
			'navigation resolves this by injection, so constructing it in tests proves nothing'
		);
	});

	test('re-derives an opened image against its accepted corrections, before anyone sees it', async () => {
		// The facts live in the analysis server, so a correction only the
		// renderer knew about would leave every xref, block and call graph
		// computed as though it had not been made. It is pushed during open, not
		// after, so no caller reads the uncorrected facts of an image the analyst
		// has already corrected.
		const { service, analysis, interpretation } = createService(store);
		const contentHash = 'a'.repeat(64);
		interpretation.corrections.set(contentHash, [{
			seq: 1,
			at: 0,
			author: { kind: 'human', id: 'analyst' },
			anchor: { kind: 'image', contentHash, rva: 0x1400n },
			op: EditOp.FunctionBounds,
			value: JSON.stringify({ kind: 'define', endRva: '0x1480' }),
			status: EditStatus.Accepted,
		}, {
			// Same op and same anchor kind, different claim: these bytes are not
			// code. It has to reach the server on its own list, because a data
			// range and a function correction are not interchangeable there.
			seq: 2,
			at: 0,
			author: { kind: 'human', id: 'analyst' },
			anchor: { kind: 'image', contentHash, rva: 0x1c00n },
			op: EditOp.FunctionBounds,
			value: JSON.stringify({ kind: 'data', endRva: '0x1d00' }),
			status: EditStatus.Accepted,
		}]);

		await service.openTarget('C:\\samples\\corrected.exe');

		assert.deepStrictEqual(analysis.correctionSets.map(entry => ({ corrections: entry.corrections, dataRanges: entry.dataRanges })), [{
			corrections: [{ rva: '0x1400', kind: 'define', end_rva: '0x1480' }],
			dataRanges: [{ rva: '0x1c00', end_rva: '0x1d00' }],
		}]);
	});

	test('says nothing to the server about an image that has no corrections', async () => {
		// A re-analysis that changes nothing is pure cost, and the common case is
		// an image nobody has corrected.
		const { service, analysis } = createService(store);

		await service.openTarget('C:\\samples\\plain.exe');

		assert.deepStrictEqual(analysis.correctionSets, []);
	});

	test('re-derives an open image when a correction is accepted, and not when one is only proposed', async () => {
		// Without this a correction takes effect only on the next open: the
		// analyst accepts it, the disclosure says what it did, and every fact
		// they then read is still derived from the uncorrected seeds. A proposal
		// changes nothing, so re-analysing on one would spend a full pass to
		// arrive at exactly the facts already in hand.
		const { service, analysis, interpretation } = createService(store);
		const contentHash = 'a'.repeat(64);
		await service.openTarget('C:\\samples\\live.exe');

		const edit = (status: EditStatus, rva: bigint): IEdit => ({
			seq: 1,
			at: 0,
			author: { kind: 'human', id: 'analyst' },
			anchor: { kind: 'image', contentHash, rva },
			op: EditOp.FunctionBounds,
			value: JSON.stringify({ kind: 'undefine' }),
			status,
		});

		const rederived: IDelverSession[] = [];
		store.add(service.onDidRederiveFacts(session => rederived.push(session)));

		interpretation.accept(edit(EditStatus.Proposed, 0x2000n));
		const afterProposal = analysis.correctionSets.length;
		interpretation.accept(edit(EditStatus.Accepted, 0x2000n));
		// Yield so the un-awaited re-derivation runs.
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			pushedOnProposal: afterProposal,
			pushedAfterAccept: analysis.correctionSets.map(entry => entry.corrections),
			// Announced after the server re-derived, not before. Without this
			// the facts change and every view keeps showing the previous
			// derivation — the one op whose whole purpose is re-derivation was
			// the one op nothing watched.
			announced: rederived.map(session => session.contentHash),
		}, {
			pushedOnProposal: 0,
			pushedAfterAccept: [[{ rva: '0x2000', kind: 'undefine' }]],
			announced: [contentHash],
		});
	});

	test('a refused correction set is announced, not swallowed', async () => {
		// A correction set applies whole or not at all, so one correction that
		// conflicts with another leaves *every* correction unapplied while the
		// review queue still shows them accepted. Swallowing that leaves the
		// analyst reading uncorrected facts with nothing on screen disagreeing,
		// which is a false claim about the sample arrived at through silence.
		const { service, analysis, interpretation } = createService(store);
		const contentHash = 'a'.repeat(64);
		await service.openTarget('C:\samples\live.exe');

		const refusals: string[] = [];
		store.add(service.onDidRefuseCorrections(({ reason }) => refusals.push(reason)));
		const rederived: string[] = [];
		store.add(service.onDidRederiveFacts(session => rederived.push(session.contentHash)));

		analysis.correctionRefusal = 'applying corrections: define at 0x1500 is inside data range 0x1000';
		interpretation.accept({
			seq: 1,
			at: 0,
			author: { kind: 'human', id: 'analyst' },
			anchor: { kind: 'image', contentHash, rva: 0x1500n },
			op: EditOp.FunctionBounds,
			value: JSON.stringify({ kind: 'define' }),
			status: EditStatus.Accepted,
		});
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual({
			refusals,
			// Nothing was re-derived, so nothing may claim it was.
			rederived,
		}, {
			refusals: ['applying corrections: define at 0x1500 is inside data range 0x1000'],
			rederived: [],
		});
	});

	test('opening a target publishes it with its content hash', async () => {
		const { service, interpretation } = createService(store);
		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(s => seen.push(s?.targetPath)));

		const session = await service.openTarget('C:\\samples\\a.exe');

		assert.deepStrictEqual(
			{ path: session.targetPath, hash: session.contentHash, dirty: service.isProjectDirty, loaded: interpretation.loaded, seen },
			{ path: 'C:\\samples\\a.exe', hash: 'a'.repeat(64), dirty: true, loaded: ['a'.repeat(64)], seen: ['C:\\samples\\a.exe'] },
		);
	});

	test('saving the active project persists it and clears the dirty state', async () => {
		const { service, projectLifecycle } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');

		const saved = await service.saveProject();

		assert.deepStrictEqual(
			{ saved, calls: projectLifecycle.saved, path: service.projectPath, dirty: service.isProjectDirty },
			{ saved: true, calls: ['C:\\samples\\a.exe'], path: 'C:\\projects\\saved.delverdb', dirty: false },
		);
	});

	test('a saved project path reaches the session, not only the entry', async () => {
		// Panes, the workspace editor input and the agent all read the path off
		// the session. Recording a Save As on the entry alone leaves every one
		// of them naming the project the analyst just moved away from.
		const { service } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(session => seen.push(session?.projectPath)));

		service.markProjectSaved('C:\\projects\\a.delverdb');

		assert.deepStrictEqual(
			{ session: service.activeSession?.projectPath, path: service.projectPath, dirty: service.isProjectDirty, seen },
			{
				session: 'C:\\projects\\a.delverdb',
				path: 'C:\\projects\\a.delverdb',
				dirty: false,
				seen: ['C:\\projects\\a.delverdb'],
			},
		);
	});

	test('opening a project publishes saved categories without opening an analysis provider', async () => {
		const { service, analysis, projectLifecycle } = createService(store);
		const hash = 'b'.repeat(64);
		const snapshot = {
			metadata: {
				schemaVersion: 6,
				currentRevisionId: 'revision-1',
				contentHash: hash,
				displayName: 'offline.exe',
				sourcePath: 'C:\\missing\\offline.exe',
				createdAt: 1,
				updatedAt: 1,
			},
			interpretations: [],
			findings: [],
			findingDecisions: [],
			toolCalls: [],
			signatures: [],
			functions: JSON.stringify({ functions: [{ rva: '0x1080' }] }),
			strings: JSON.stringify({ strings: [], truncated: false }),
		} as IDelverProjectSnapshot;
		projectLifecycle.openedProject = {
			path: 'C:\\projects\\offline.delverdb',
			contentHash: hash,
			displayName: 'offline.exe',
			sourcePath: 'C:\\missing\\offline.exe',
			snapshot,
		};

		const session = await service.openProject('C:\\projects\\offline.delverdb');
		const functions = await service.functions();

		assert.deepStrictEqual({
			providerOpens: analysis.opened,
			session: { id: session.sessionId, path: session.targetPath, projectPath: session.projectPath, hash: session.contentHash },
			functions: functions.functions.map(fn => fn.rva),
			dirty: service.isProjectDirty,
		}, {
			providerOpens: [],
			session: { id: undefined, path: 'C:\\missing\\offline.exe', projectPath: 'C:\\projects\\offline.delverdb', hash },
			functions: ['0x1080'],
			dirty: false,
		});
	});

	test('opening a project automatically attaches its matching target from the workspace', async () => {
		const { service, analysis, projectLifecycle } = createService(store);
		const hash = 'b'.repeat(64);
		const targetPath = 'C:\\workspace\\bin\\sample.exe';
		analysis.contentHash = hash;
		projectLifecycle.openedProject = openedProject(hash, targetPath);

		const session = await service.openProject('C:\\workspace\\sample.delverdb');

		assert.deepStrictEqual({
			opened: analysis.opened,
			closed: analysis.closed,
			session: { id: session.sessionId, path: session.targetPath, projectPath: session.projectPath, hash: session.contentHash },
			dirty: service.isProjectDirty,
		}, {
			opened: [targetPath],
			closed: [],
			session: { id: 'session-1', path: targetPath, projectPath: 'C:\\workspace\\sample.delverdb', hash },
			dirty: false,
		});
	});

	test('hash mismatch, unavailable target, or workspace escape leaves the project offline', async () => {
		const mismatch = createService(store);
		const projectHash = 'b'.repeat(64);
		const mismatchPath = 'C:\\workspace\\bin\\changed.exe';
		mismatch.analysis.contentHash = 'c'.repeat(64);
		mismatch.projectLifecycle.openedProject = openedProject(projectHash, mismatchPath);
		const mismatchedSession = await mismatch.service.openProject('C:\\workspace\\sample.delverdb');

		const unavailable = createService(store);
		const missingPath = 'C:\\workspace\\bin\\missing.exe';
		unavailable.analysis.openErrors.add(missingPath);
		unavailable.projectLifecycle.openedProject = openedProject(projectHash, missingPath);
		const unavailableSession = await unavailable.service.openProject('C:\\workspace\\sample.delverdb');

		const escaped = createService(store);
		const escapedPath = 'C:\\workspace\\..\\outside.exe';
		escaped.projectLifecycle.openedProject = openedProject(projectHash, escapedPath);
		const escapedSession = await escaped.service.openProject('C:\\workspace\\sample.delverdb');

		assert.deepStrictEqual({
			mismatch: { id: mismatchedSession.sessionId, opened: mismatch.analysis.opened, closed: mismatch.analysis.closed },
			unavailable: { id: unavailableSession.sessionId, opened: unavailable.analysis.opened, closed: unavailable.analysis.closed },
			escaped: { id: escapedSession.sessionId, opened: escaped.analysis.opened },
		}, {
			mismatch: { id: undefined, opened: [mismatchPath], closed: ['session-1'] },
			unavailable: { id: undefined, opened: [missingPath], closed: [] },
			escaped: { id: undefined, opened: [] },
		});
	});

	test('attaching mismatched bytes preserves the offline project session', async () => {
		const { service, analysis, projectLifecycle } = createService(store);
		const projectHash = 'b'.repeat(64);
		const snapshot = {
			metadata: {
				schemaVersion: 6,
				currentRevisionId: 'revision-1',
				contentHash: projectHash,
				displayName: 'offline.exe',
				createdAt: 1,
				updatedAt: 1,
			},
			interpretations: [],
			findings: [],
			findingDecisions: [],
			toolCalls: [],
			signatures: [],
		} as IDelverProjectSnapshot;
		projectLifecycle.openedProject = {
			path: 'C:\\projects\\offline.delverdb',
			contentHash: projectHash,
			displayName: 'offline.exe',
			snapshot,
		};
		const offline = await service.openProject('C:\\projects\\offline.delverdb');

		await assert.rejects(() => service.attachTarget('C:\\samples\\wrong.exe'), /SHA-256 differs/);

		assert.deepStrictEqual({
			activeIsOffline: service.activeSession === offline,
			activeHash: service.activeSession?.contentHash,
			opened: analysis.opened,
			closed: analysis.closed,
		}, {
			activeIsOffline: true,
			activeHash: projectHash,
			opened: ['C:\\samples\\wrong.exe'],
			closed: ['session-1'],
		});
	});

	test('locating a target rekeys the offline project session to the selected target', async () => {
		const { service, analysis, projectLifecycle } = createService(store);
		const hash = 'b'.repeat(64);
		const projectPath = 'C:\\workspace\\offline.delverdb';
		const locatedPath = 'C:\\workspace\\bin\\located.exe';
		analysis.contentHash = hash;
		projectLifecycle.openedProject = { ...openedProject(hash, 'C:\\missing\\offline.exe'), path: projectPath };
		await service.openProject(projectPath);

		const attached = await service.attachTarget(locatedPath);
		await service.openTarget('C:\\workspace\\bin\\other.exe');
		service.setActiveTarget(locatedPath);

		assert.deepStrictEqual({
			attached: { targetPath: attached.targetPath, projectPath: attached.projectPath },
			active: { targetPath: service.activeSession?.targetPath, projectPath: service.activeSession?.projectPath },
		}, {
			attached: { targetPath: locatedPath, projectPath },
			active: { targetPath: locatedPath, projectPath },
		});
	});

	test('locating a target waits for an in-flight open', async () => {
		// Locating starts a provider pair exactly as opening does, so it belongs
		// in the same queue. Off the queue it decides against a session the open
		// is about to replace, and the pair it started answers for nobody.
		const { service, analysis } = createService(store);
		analysis.openGate = new DeferredPromise<void>();
		const open = service.openTarget('C:\\samples\\a.exe');
		await analysis.openReachedGate.p;

		const attach = service.attachTarget('C:\\samples\\b.exe').then(() => 'attached', error => error.message);
		const duringOpen = [...analysis.opened];
		analysis.openGate.complete();
		await open;

		assert.deepStrictEqual(
			{ duringOpen, opened: analysis.opened, attach: await attach },
			{
				duringOpen: ['C:\\samples\\a.exe'],
				opened: ['C:\\samples\\a.exe'],
				attach: 'Open a Delver project before locating its target.',
			},
		);
	});

	test('locating a target releases a pair it cannot install', async () => {
		// The candidate is analysed before it can be adopted, and the project it
		// was located for can go away in between. Dropping it there orphans a
		// provider pair that keeps the sample mapped for the rest of the session.
		const { service, analysis, projectLifecycle } = createService(store);
		const hash = 'b'.repeat(64);
		analysis.contentHash = hash;
		projectLifecycle.openedProject = openedProject(hash, 'C:\\missing\\offline.exe');
		await service.openProject('C:\\projects\\offline.delverdb');

		analysis.openGate = new DeferredPromise<void>();
		const attach = service.attachTarget('C:\\samples\\located.exe').then(() => 'attached', error => error.message);
		await analysis.openReachedGate.p;
		await service.closeTarget();
		analysis.openGate.complete();

		assert.deepStrictEqual(
			{ attach: await attach, opened: analysis.opened, closed: analysis.closed, active: service.activeSession },
			{
				attach: 'The project this target was located for is no longer open.',
				opened: ['C:\\samples\\located.exe'],
				closed: ['session-1'],
				active: undefined,
			},
		);
	});

	test('a stale provider without a content hash closes with an actionable error', async () => {
		const { service, analysis } = createService(store);
		analysis.contentHash = undefined;

		await assert.rejects(() => service.openTarget('C:\\samples\\a.exe'), /Rebuild or update provider-file/);

		assert.deepStrictEqual(
			{ active: service.activeSession, closed: analysis.closed },
			{ active: undefined, closed: ['session-1'] },
		);
	});

	test('a failed interpretation replay closes the analysis session without publishing it', async () => {
		const { service, analysis, interpretation } = createService(store);
		interpretation.loadError = new Error('bad log');

		await assert.rejects(() => service.openTarget('C:\\samples\\a.exe'), /bad log/);

		assert.deepStrictEqual(
			{ active: service.activeSession, closed: analysis.closed },
			{ active: undefined, closed: ['session-1'] },
		);
	});

	test('re-opening the same target reuses the session', async () => {
		// This is what makes switching between the listing and strings tabs free.
		// Re-analysing would take seconds and would throw away the session every
		// other view is holding.
		const { service, analysis } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');

		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(s => seen.push(s?.targetPath)));
		const second = await service.openTarget('C:\\samples\\a.exe');

		assert.deepStrictEqual(
			{ same: first.sessionId === second.sessionId, opens: analysis.opened.length, seen },
			{ same: true, opens: 1, seen: [] },
		);
	});

	test('opening a second target leaves the first one open', async () => {
		// Reversed by ADR 0008. A workspace editor exists per target, so evicting
		// the previous session here is what made a second workspace render the
		// first one's binary. A session now closes with its workspace.
		const { service, analysis } = createService(store);
		await service.openTarget('C:\samples\a.exe');
		await service.openTarget('C:\samples\b.exe');

		assert.deepStrictEqual(
			{ closed: analysis.closed, active: service.activeSession?.targetPath },
			{ closed: [], active: 'C:\samples\b.exe' },
		);
	});

	test('the active target follows whichever workspace claims it', async () => {
		const { service } = createService(store);
		await service.openTarget('C:\samples\a.exe');
		await service.openTarget('C:\samples\b.exe');

		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(session => seen.push(session?.targetPath)));
		service.setActiveTarget('C:\samples\a.exe');
		const afterSwitch = service.activeSession?.targetPath;
		// Re-claiming the same target announces nothing, and a target that was
		// never opened cannot become active.
		service.setActiveTarget('C:\samples\a.exe');
		service.setActiveTarget('C:\samples\never.exe');

		assert.deepStrictEqual(
			{ afterSwitch, active: service.activeSession?.targetPath, seen },
			{ afterSwitch: 'C:\samples\a.exe', active: 'C:\samples\a.exe', seen: ['C:\samples\a.exe'] },
		);
	});

	test('closing one target hands the implicit API to another still open', async () => {
		const { service } = createService(store);
		const kept = await service.openTarget('C:\samples\a.exe');
		await service.openTarget('C:\samples\b.exe');

		await service.closeTarget('C:\samples\b.exe');

		assert.strictEqual(service.activeSession?.targetPath, kept.targetPath);
	});

	test('closing clears the session and announces it', async () => {
		const { service, analysis } = createService(store);
		const session = await service.openTarget('C:\\samples\\a.exe');

		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(s => seen.push(s?.targetPath)));
		await service.closeTarget();

		assert.deepStrictEqual(
			{ active: service.activeSession, closed: analysis.closed, seen },
			{ active: undefined, closed: [session.sessionId], seen: [undefined] },
		);
	});

	test('concurrent opens of the same target do not start two sessions', async () => {
		// Two editors restoring at once is the ordinary case, not an edge one.
		const { service, analysis } = createService(store);

		const [a, b] = await Promise.all([
			service.openTarget('C:\\samples\\a.exe'),
			service.openTarget('C:\\samples\\a.exe'),
		]);

		assert.deepStrictEqual(
			{ same: a.sessionId === b.sessionId, opens: analysis.opened.length },
			{ same: true, opens: 1 },
		);
	});

	test('refreshing unchanged bytes keeps the hot session', async () => {
		const { service, analysis, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');

		const refreshed = await service.refreshTarget('C:\\samples\\a.exe');

		assert.deepStrictEqual(
			{ session: refreshed.sessionId, opened: analysis.opened, closed: analysis.closed, prompts: dialog.prompts },
			{ session: first.sessionId, opened: ['C:\\samples\\a.exe', 'C:\\samples\\a.exe'], closed: ['session-2'], prompts: 0 },
		);
	});

	test('canceling an updated binary preserves the old revision and session', async () => {
		const { service, analysis, projectLifecycle, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		projectLifecycle.projectPaths.set(first.contentHash, 'C:\\projects\\a.delverdb');
		service.markProjectSaved('C:\\projects\\a.delverdb');
		analysis.contentHash = 'b'.repeat(64);
		dialog.decision = 'cancel';

		await assert.rejects(() => service.refreshTarget(first.targetPath), error => error instanceof CancellationError);

		assert.deepStrictEqual(
			{ active: service.activeSession?.sessionId, hash: service.activeSession?.contentHash, closed: analysis.closed, revisions: projectLifecycle.revisions },
			{ active: first.sessionId, hash: 'a'.repeat(64), closed: ['session-2'], revisions: [] },
		);
	});

	test('updated binary can be appended as a new revision without replacing the old one', async () => {
		const { service, analysis, projectLifecycle, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		projectLifecycle.projectPaths.set(first.contentHash, 'C:\\projects\\a.delverdb');
		service.markProjectSaved('C:\\projects\\a.delverdb');
		analysis.contentHash = 'b'.repeat(64);
		dialog.decision = 'addRevision';

		const refreshed = await service.refreshTarget(first.targetPath);

		assert.deepStrictEqual(
			{
				hash: refreshed.contentHash,
				closed: analysis.closed,
				revisions: projectLifecycle.revisions,
				oldPath: projectLifecycle.projectPath(first.contentHash),
				newPath: projectLifecycle.projectPath(refreshed.contentHash),
				dirty: service.isProjectDirty,
			},
			{
				hash: 'b'.repeat(64),
				closed: ['session-1'],
				revisions: [{ previous: 'a'.repeat(64), updated: 'b'.repeat(64) }],
				oldPath: 'C:\\projects\\a.delverdb',
				newPath: 'C:\\projects\\a.delverdb',
				dirty: false,
			},
		);
	});

	test('updated binary can be saved as a separate project', async () => {
		const { service, analysis, projectLifecycle, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		projectLifecycle.projectPaths.set(first.contentHash, 'C:\\projects\\a.delverdb');
		service.markProjectSaved('C:\\projects\\a.delverdb');
		analysis.contentHash = 'b'.repeat(64);
		dialog.decision = 'createProject';

		const refreshed = await service.refreshTarget(first.targetPath);

		assert.deepStrictEqual(
			{ hash: refreshed.contentHash, closed: analysis.closed, projectPath: service.projectPath, dirty: service.isProjectDirty },
			{ hash: 'b'.repeat(64), closed: ['session-1'], projectPath: 'C:\\projects\\updated.delverdb', dirty: false },
		);
	});

	test('canceling new-project Save As preserves the previous project', async () => {
		const { service, analysis, projectLifecycle, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		projectLifecycle.projectPaths.set(first.contentHash, 'C:\\projects\\a.delverdb');
		projectLifecycle.createProjectResult = false;
		service.markProjectSaved('C:\\projects\\a.delverdb');
		analysis.contentHash = 'b'.repeat(64);
		dialog.decision = 'createProject';

		await assert.rejects(() => service.refreshTarget(first.targetPath), error => error instanceof CancellationError);

		assert.deepStrictEqual(
			{ active: service.activeSession?.contentHash, closed: analysis.closed, projectPath: service.projectPath },
			{ active: 'a'.repeat(64), closed: ['session-2'], projectPath: 'C:\\projects\\a.delverdb' },
		);
	});

	test('opening a second target never prompts about the first', async () => {
		// Was: opening prompted to save and cancelling refused the open. Under
		// ADR 0008 opening evicts nothing, so there is nothing to save or refuse.
		const { service, analysis, dialog, projectLifecycle } = createService(store);
		await service.openTarget('C:\samples\a.exe');
		dialog.decision = 'cancel';

		const second = await service.openTarget('C:\samples\b.exe');

		assert.deepStrictEqual(
			{
				active: second.targetPath,
				opened: analysis.opened,
				closed: analysis.closed,
				saved: projectLifecycle.saved,
			},
			{ active: 'C:\samples\b.exe', opened: ['C:\samples\a.exe', 'C:\samples\b.exe'], closed: [], saved: [] },
		);
	});

	test('dirty state belongs to a target, not to the service', async () => {
		const { service } = createService(store);
		await service.openTarget('C:\samples\a.exe');
		service.markProjectDirty();
		await service.openTarget('C:\samples\b.exe');
		const secondDirty = service.isProjectDirty;

		service.setActiveTarget('C:\samples\a.exe');

		assert.deepStrictEqual(
			{ secondDirty, firstDirty: service.isProjectDirty },
			{ secondDirty: true, firstDirty: true },
		);
	});

	test('a failed or canceled save prevents closing the target', async () => {
		const { service, projectLifecycle, dialog } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		dialog.decision = 'save';
		projectLifecycle.saveResult = false;

		const closed = await service.closeTarget();

		assert.deepStrictEqual(
			{ closed, active: service.activeSession?.targetPath, dirty: service.isProjectDirty },
			{ closed: false, active: 'C:\\samples\\a.exe', dirty: true },
		);
	});

	test('saved projects close without repeatedly prompting', async () => {
		const { service, dialog } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		service.markProjectSaved('C:\\projects\\a.delver');

		const closed = await service.closeTarget();

		assert.deepStrictEqual(
			{ closed, prompts: dialog.prompts, active: service.activeSession, projectPath: service.projectPath },
			{ closed: true, prompts: 0, active: undefined, projectPath: undefined },
		);
	});

	test('canceling the shutdown prompt vetoes shutdown', async () => {
		const { service, dialog, lifecycle } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		dialog.decision = 'cancel';
		let veto: boolean | Promise<boolean> = false;

		lifecycle.fireBeforeShutdown({
			reason: ShutdownReason.QUIT,
			veto: value => veto = value,
			finalVeto: () => undefined,
		});

		assert.deepStrictEqual(
			{ veto: await veto, active: service.activeSession?.targetPath, dirty: service.isProjectDirty },
			{ veto: true, active: 'C:\\samples\\a.exe', dirty: true },
		);
	});

	test('shutdown releases every open target before the window goes', async () => {
		// The provider pairs outlive the window unless something closes them,
		// and a release the window does not wait for is a release that may
		// never be sent — leaving a child with the sample still mapped.
		const { service, analysis, lifecycle } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		await service.openTarget('C:\\samples\\b.exe');

		lifecycle.fireShutdown();
		const joiners = lifecycle.shutdownJoiners.length;
		await Promise.all(lifecycle.shutdownJoiners);

		assert.deepStrictEqual(
			{ joiners, closed: analysis.closed, active: service.activeSession },
			{ joiners: 1, closed: ['session-1', 'session-2'], active: undefined },
		);
	});

	test('successful shutdown save allows shutdown and does not prompt again', async () => {
		const { service, projectLifecycle, dialog, lifecycle } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		dialog.decision = 'save';
		const vetos: (boolean | Promise<boolean>)[] = [];
		const event = {
			reason: ShutdownReason.QUIT,
			veto: (value: boolean | Promise<boolean>) => vetos.push(value),
			finalVeto: () => undefined,
		};

		lifecycle.fireBeforeShutdown(event);
		assert.strictEqual(await vetos[0], false);
		lifecycle.fireBeforeShutdown(event);

		assert.deepStrictEqual(
			{ secondVeto: await vetos[1], saved: projectLifecycle.saved, prompts: dialog.prompts, dirty: service.isProjectDirty },
			{ secondVeto: false, saved: ['C:\\samples\\a.exe'], prompts: 1, dirty: false },
		);
	});
});
