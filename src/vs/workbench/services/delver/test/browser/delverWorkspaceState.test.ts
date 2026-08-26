/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { DelverSurfaceId } from '../../browser/delverSurface.js';
import { DelverRecentTargetsStore, normalizeDelverWorkspaceState } from '../../browser/delverWorkspaceState.js';

/** Minimal object-store stand-in; only the two methods the store calls. */
function memoryStorage(seed?: unknown): IStorageService {
	let value = seed;
	return {
		getObject: (_key: string, _scope: StorageScope, fallback: object) => value ?? fallback,
		store: (_key: string, next: unknown) => { value = next; },
	} as unknown as IStorageService;
}

suite('Delver workspace state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips valid state and rejects malformed persisted values', () => {
		assert.deepStrictEqual(normalizeDelverWorkspaceState({
			navigatorWidth: 320,
			inspectorWidth: 360,
			navigatorSurfaceId: DelverSurfaceId.Strings,
			inspectorSurfaceId: DelverSurfaceId.Review,
			primarySurfaceId: DelverSurfaceId.Imports,
		}), {
			navigatorWidth: 320,
			inspectorWidth: 360,
			navigatorSurfaceId: DelverSurfaceId.Strings,
			inspectorSurfaceId: DelverSurfaceId.Review,
			primarySurfaceId: DelverSurfaceId.Imports,
		});

		assert.deepStrictEqual(normalizeDelverWorkspaceState({
			navigatorWidth: Number.NaN,
			inspectorWidth: 40,
			navigatorSurfaceId: '',
			inspectorSurfaceId: 'x'.repeat(201),
			primarySurfaceId: '',
		}), {
			navigatorWidth: 280,
			inspectorWidth: 280,
			navigatorSurfaceId: DelverSurfaceId.Functions,
			inspectorSurfaceId: DelverSurfaceId.Xrefs,
			primarySurfaceId: DelverSurfaceId.Listing,
		});
	});

	test('recent targets are most-recent-first, deduplicated, and capped', () => {
		const store = new DelverRecentTargetsStore(memoryStorage());

		store.add('a.exe');
		store.add('b.exe');
		store.add('a.exe');
		const afterRepeat = store.list();

		for (let i = 0; i < 12; i++) {
			store.add(`sample${i}.exe`);
		}

		assert.deepStrictEqual({
			afterRepeat: [...afterRepeat],
			capped: store.list().length,
			newestFirst: store.list()[0],
		}, {
			// Re-opening a target promotes it rather than listing it twice.
			afterRepeat: ['a.exe', 'b.exe'],
			capped: 10,
			newestFirst: 'sample11.exe',
		});
	});

	test('hostile or downgraded stored data never reaches the launcher', () => {
		assert.deepStrictEqual(
			[...new DelverRecentTargetsStore(memoryStorage([null, 'a.exe', 42, '', { path: 'b.exe' }])).list()],
			['a.exe'],
		);
		assert.deepStrictEqual([...new DelverRecentTargetsStore(memoryStorage('not-an-array')).list()], []);
	});
});
