/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IPrompt, IPromptResult, IPromptResultWithCancel, IPromptWithCustomCancel, IPromptWithDefaultCancel } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { DelverFindingOutcome, IDelverFinding, IDelverFindingDecision, IDelverFindingDraft } from '../../../../../platform/delver/common/findings.js';
import { IDelverProjectSnapshot } from '../../../../../platform/delver/common/delverProjectStoreService.js';
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
	private next = 1;

	async openImage(config: { kind: 'file'; path: string }) {
		this.opened.push(config.path);
		if (this.openErrors.has(config.path)) {
			throw new Error('target unavailable');
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

	async load(contentHash: string): Promise<void> {
		this.loaded.push(contentHash);
		if (this.loadError) {
			throw this.loadError;
		}
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

	projectPath(contentHash: string): string | undefined { return this.projectPaths.get(contentHash); }

	projectSnapshot(contentHash: string): IDelverProjectSnapshot | undefined {
		return this.openedProject?.contentHash === contentHash ? this.openedProject.snapshot : undefined;
	}
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

	test('opening a different target closes the previous one', async () => {
		// A session owns two child processes; leaving the old one running would
		// leak a provider pair per file opened.
		const { service, analysis } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		await service.openTarget('C:\\samples\\b.exe');

		assert.deepStrictEqual(
			{ closed: analysis.closed, active: service.activeSession?.targetPath },
			{ closed: [first.sessionId], active: 'C:\\samples\\b.exe' },
		);
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

	test('canceling the save prompt keeps the current target open', async () => {
		const { service, analysis, dialog } = createService(store);
		const first = await service.openTarget('C:\\samples\\a.exe');
		dialog.decision = 'cancel';

		await assert.rejects(() => service.openTarget('C:\\samples\\b.exe'), error => error instanceof CancellationError);

		assert.deepStrictEqual(
			{ active: service.activeSession?.targetPath, opened: analysis.opened, closed: analysis.closed },
			{ active: first.targetPath, opened: ['C:\\samples\\a.exe'], closed: [] },
		);
	});

	test('saving before target replacement clears the old project state', async () => {
		const { service, projectLifecycle, dialog } = createService(store);
		await service.openTarget('C:\\samples\\a.exe');
		dialog.decision = 'save';

		await service.openTarget('C:\\samples\\b.exe');

		assert.deepStrictEqual(
			{ saved: projectLifecycle.saved, active: service.activeSession?.targetPath, dirty: service.isProjectDirty },
			{ saved: ['C:\\samples\\a.exe'], active: 'C:\\samples\\b.exe', dirty: true },
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
