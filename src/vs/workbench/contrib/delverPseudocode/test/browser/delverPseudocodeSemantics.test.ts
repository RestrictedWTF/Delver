/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditOp } from '../../../../../platform/delver/common/interpretation.js';
import { isSemanticOp } from '../../browser/delverPseudocodeWidget.js';

suite('Delver pseudocode semantics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('separates edits the decompiler consumes from edits drawn over its output', () => {
		// The pane re-decompiles for the first group and merely re-renders for
		// the second. Getting a member of the first group wrong is silent: the
		// analyst accepts something and the C in front of them does not change.
		// That has happened twice — `CompositeType` and `FunctionBounds` were
		// each missing from this list after being added to `EditOp`.
		//
		// `EditOp` is a const enum and cannot be enumerated at runtime, so this
		// list is written out rather than derived. That makes it the same kind
		// of tripwire as a literal count: a new op does not fail here on its
		// own, but classifying one wrongly does, and adding one means being
		// asked the question.
		const classified = {
			// Inputs — these change the C itself.
			dataType: isSemanticOp(EditOp.DataType),
			functionPrototype: isSemanticOp(EditOp.FunctionPrototype),
			compositeType: isSemanticOp(EditOp.CompositeType),
			// A correction changes where the function *is*, a stronger change
			// than a type: the pane may be showing bounds that no longer exist.
			functionBounds: isSemanticOp(EditOp.FunctionBounds),
			// Overlays — the C stays correct, only the decoration changes.
			rename: isSemanticOp(EditOp.Rename),
			comment: isSemanticOp(EditOp.Comment),
			tags: isSemanticOp(EditOp.Tags),
		};

		assert.deepStrictEqual(classified, {
			dataType: true,
			functionPrototype: true,
			compositeType: true,
			functionBounds: true,
			rename: false,
			comment: false,
			tags: false,
		});
	});
});
