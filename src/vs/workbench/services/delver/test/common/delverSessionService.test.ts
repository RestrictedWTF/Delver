/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import {
	DelverSessionService,
	IDelverSession,
	IDelverSessionService,
} from '../../common/delverSessionService.js';

function session(sessionId: string): IDelverSession {
	return {
		sessionId,
		targetPath: `C:\\samples\\${sessionId}.exe`,
		image: {
			image_id: 'image-0',
			arch: 'X86_64',
			instruction_count: 100,
			function_count: 4,
			xref_count: 8,
			string_count: 2,
		},
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

	test('publishing a session announces it', () => {
		const service = store.add(new DelverSessionService());
		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(s => seen.push(s?.sessionId)));

		service.setActiveSession(session('a'));

		assert.deepStrictEqual(
			{ active: service.activeSession?.sessionId, seen },
			{ active: 'a', seen: ['a'] },
		);
	});

	test('republishing the same session is not a change', () => {
		const service = store.add(new DelverSessionService());
		service.setActiveSession(session('a'));

		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActiveSession(s => seen.push(s?.sessionId)));
		service.setActiveSession(session('a'));

		assert.deepStrictEqual(seen, []);
	});

	test('a closing editor cannot clear the session that replaced its own', () => {
		// Opening a second listing publishes 'b', and only then is the first
		// editor disposed. Clearing unconditionally there would leave navigation
		// with no session while a perfectly good listing is on screen.
		const service = store.add(new DelverSessionService());
		const first = session('a');
		service.setActiveSession(first);
		service.setActiveSession(session('b'));

		service.setActiveSession(undefined, first);

		assert.strictEqual(service.activeSession?.sessionId, 'b');
	});

	test('a closing editor clears its own session', () => {
		const service = store.add(new DelverSessionService());
		const only = session('a');
		service.setActiveSession(only);

		service.setActiveSession(undefined, only);

		assert.strictEqual(service.activeSession, undefined);
	});
});
