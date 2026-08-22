/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DELVER_AGENT_CAPABILITIES } from '../../../../services/delver/common/delverAgentService.js';
import { getDelverAgentToolData } from '../../browser/delverAIToolDefinitions.js';

suite('Delver AI Tool Definitions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps capability ids as globally unambiguous tool references', () => {
		const tools = getDelverAgentToolData();

		assert.deepStrictEqual(tools.map(tool => ({
			id: tool.id,
			reference: tool.toolReferenceName,
			canBeReferenced: tool.canBeReferencedInPrompt,
		})), DELVER_AGENT_CAPABILITIES.map(capability => ({
			id: capability.id,
			reference: capability.id,
			canBeReferenced: true,
		})));
	});
});
