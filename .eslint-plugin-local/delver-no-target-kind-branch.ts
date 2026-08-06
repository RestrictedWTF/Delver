/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as eslint from 'eslint';
import { TSESTree } from '@typescript-eslint/utils';

/**
 * Forbids branching on `target.kind` in Delver code. Use capabilities instead.
 */
export default new class DelverNoTargetKindBranch implements eslint.Rule.RuleModule {

	create(context: eslint.Rule.RuleContext): eslint.Rule.RuleListener {
		return {
			'MemberExpression[property.type="Identifier"][property.name="kind"]'(node: TSESTree.MemberExpression) {
				const object = node.object;
				if (object.type === 'Identifier' && /target/i.test(object.name)) {
					context.report({
						node,
						message: `Do not branch on '${object.name}.kind'. Use TargetCapability instead.`
					});
				}
			}
		};
	}
};
