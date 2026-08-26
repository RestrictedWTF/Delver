/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DelverWorkspaceInput, DelverWorkspaceInputSerializer } from '../../browser/delverWorkspaceInput.js';

suite('Delver workspace input', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is target-keyed and round-trips through its serializer', () => {
		const input = disposables.add(new DelverWorkspaceInput('C:\\samples\\first.exe'));
		const same = disposables.add(new DelverWorkspaceInput('C:\\samples\\first.exe'));
		const other = disposables.add(new DelverWorkspaceInput('C:\\samples\\other.exe'));
		const serializer = new DelverWorkspaceInputSerializer();
		const restored = serializer.deserialize(undefined!, serializer.serialize(input));
		if (restored) {
			disposables.add(restored);
		}

		assert.deepStrictEqual({
			name: input.getName(),
			matchesSame: input.matches(same),
			matchesOther: input.matches(other),
			restoredPath: restored?.targetPath,
			invalid: serializer.deserialize(undefined!, '{'),
		}, {
			name: 'first.exe',
			matchesSame: true,
			matchesOther: false,
			restoredPath: 'C:\\samples\\first.exe',
			invalid: undefined,
		});
	});
});
