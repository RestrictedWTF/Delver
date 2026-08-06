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

		/**
		 * Names whose `.kind` is the target-kind discriminator. Deliberately not
		 * every `.kind`: address spaces and moments legitimately have one.
		 */
		const isTargetLike = (name: string) => /^(.*target|descriptor|snapshot)$/i.test(name);

		/** Resolves the receiver name for `x.kind`, `this.x.kind`, and `a.b.x.kind`. */
		const receiverName = (object: TSESTree.Node): string | undefined => {
			if (object.type === 'Identifier') {
				return object.name;
			}
			if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
				return object.property.name;
			}
			return undefined;
		};

		/**
		 * Whether this `.kind` read actually decides control flow.
		 *
		 * Reading the kind to display or log it is fine — the invariant is that
		 * *behavior* must not depend on it. Restricting the rule to branching
		 * constructs keeps it precise enough that nobody needs to disable it.
		 */
		const isBranchingOn = (node: TSESTree.Node): boolean => {
			const parent = node.parent as TSESTree.Node | undefined;
			if (!parent) {
				return false;
			}
			switch (parent.type) {
				case 'BinaryExpression':
					return ['===', '!==', '==', '!='].includes(parent.operator);
				case 'SwitchStatement':
					return parent.discriminant === node;
				case 'IfStatement':
					return parent.test === node;
				case 'ConditionalExpression':
					return parent.test === node;
				case 'UnaryExpression':
					return parent.operator === '!';
				default:
					return false;
			}
		};

		return {
			'MemberExpression[property.type="Identifier"][property.name="kind"]'(node: TSESTree.MemberExpression) {
				const name = receiverName(node.object);
				if (name && isTargetLike(name) && isBranchingOn(node as unknown as TSESTree.Node)) {
					context.report({
						node,
						message: `Do not branch on '${name}.kind'. Use TargetCapability instead.`
					});
				}
			}
		};
	}
};
