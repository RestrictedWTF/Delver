/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import {
	DelverSessionService,
	IDelverSessionService,
} from '../../common/delverSessionService.js';

/** Records opens and closes so lifetime can be asserted. */
class FakeAnalysisService implements Partial<IDelverAnalysisService> {
	readonly opened: string[] = [];
	readonly closed: string[] = [];
	contentHash: string | undefined = 'a'.repeat(64);
	private next = 1;

	async openImage(config: { kind: 'file'; path: string }) {
		this.opened.push(config.path);
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

function createService(store: Pick<ReturnType<typeof ensureNoDisposablesAreLeakedInTestSuite>, 'add'>) {
	const analysis = new FakeAnalysisService();
	const interpretation = new FakeInterpretationService();
	const service = store.add(new DelverSessionService(
		analysis as unknown as IDelverAnalysisService,
		interpretation as unknown as IDelverInterpretationService,
		new MockContextKeyService(),
	));
	return { service, analysis, interpretation };
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
			{ path: session.targetPath, hash: session.contentHash, loaded: interpretation.loaded, seen },
			{ path: 'C:\\samples\\a.exe', hash: 'a'.repeat(64), loaded: ['a'.repeat(64)], seen: ['C:\\samples\\a.exe'] },
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
});
