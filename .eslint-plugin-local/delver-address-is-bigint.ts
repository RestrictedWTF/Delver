/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as eslint from 'eslint';
import { TSESTree } from '@typescript-eslint/utils';

const ADDRESS_LIKE = /(^|_)(address|addr|rva|offset|entry|base|imageBase|image_base|virtual_address|raw_offset)($|_)/i;

/**
 * Ensures address-like identifiers in Delver code are typed as `bigint` or
 * `string` (for wire hex strings), not `number`.
 */
export default new class DelverAddressIsBigint implements eslint.Rule.RuleModule {

	create(context: eslint.Rule.RuleContext): eslint.Rule.RuleListener {
		return {
			'TSPropertySignature[typeAnnotation.typeAnnotation.type="TSNumberKeyword"]'(node: TSESTree.TSPropertySignature) {
				if (node.key.type === 'Identifier' && ADDRESS_LIKE.test(node.key.name)) {
					context.report({
						node,
						message: `Address-like property '${node.key.name}' must be typed as bigint or string, not number.`
					});
				}
			},
			'TSTypeAnnotation[typeAnnotation.type="TSNumberKeyword"]'(node: TSESTree.TSTypeAnnotation) {
				const parent = node.parent;
				if (parent?.type === 'Identifier' && ADDRESS_LIKE.test(parent.name)) {
					context.report({
						node,
						message: `Address-like identifier '${parent.name}' must be typed as bigint or string, not number.`
					});
				}
			}
		};
	}
};
