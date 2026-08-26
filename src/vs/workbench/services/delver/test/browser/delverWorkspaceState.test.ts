/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DelverSurfaceId } from '../../browser/delverSurface.js';
import { normalizeDelverWorkspaceState } from '../../browser/delverWorkspaceState.js';

suite('Delver workspace state', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips valid state and rejects malformed persisted values', () => {
		assert.deepStrictEqual(normalizeDelverWorkspaceState({
			navigatorWidth: 320,
			inspectorWidth: 360,
			navigatorSurfaceId: DelverSurfaceId.Strings,
			inspectorSurfaceId: DelverSurfaceId.Review,
			primaryMode: 'reading',
		}), {
			navigatorWidth: 320,
			inspectorWidth: 360,
			navigatorSurfaceId: DelverSurfaceId.Strings,
			inspectorSurfaceId: DelverSurfaceId.Review,
			primaryMode: 'reading',
		});

		assert.deepStrictEqual(normalizeDelverWorkspaceState({
			navigatorWidth: Number.NaN,
			inspectorWidth: 40,
			navigatorSurfaceId: '',
			inspectorSurfaceId: 'x'.repeat(201),
			primaryMode: 'broken' as never,
		}), {
			navigatorWidth: 240,
			inspectorWidth: 280,
			navigatorSurfaceId: DelverSurfaceId.Functions,
			inspectorSurfaceId: DelverSurfaceId.Xrefs,
			primaryMode: 'overview',
		});
	});
});
