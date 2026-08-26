/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import {
	DELVER_SELECTION_NONE,
	DelverSelectionService,
	IDelverSelection,
	whenSelectionIs,
} from '../../common/delverSelection.js';

suite('Delver selection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function selectionService() {
		const contextKeyService = disposables.add(new ContextKeyService(new TestConfigurationService()));
		const service = disposables.add(new DelverSelectionService(contextKeyService));
		return { contextKeyService, service };
	}

	test('a function action is offered only while a function is selected', () => {
		const { contextKeyService, service } = selectionService();
		const functionAction = whenSelectionIs('function');
		const enabled = () => contextKeyService.contextMatchesRules(functionAction);

		const beforeAnything = enabled();
		service.setSelection({ kind: 'instruction', address: '0x401044' });
		const onInstruction = enabled();
		service.setSelection({ kind: 'function', address: '0x401040' });
		const onFunction = enabled();
		service.setSelection({ kind: 'section' });
		const onSection = enabled();

		// This is the whole point of binding actions to a selection kind:
		// "Generate Signature" cannot appear while a section is selected,
		// because it is not an action on sections.
		assert.deepStrictEqual(
			{ beforeAnything, onInstruction, onFunction, onSection },
			{ beforeAnything: false, onInstruction: false, onFunction: true, onSection: false },
		);
	});

	test('an action accepting several kinds matches any of them', () => {
		const { contextKeyService, service } = selectionService();
		const addressable = whenSelectionIs('function', 'instruction', 'string');
		const enabled = () => contextKeyService.contextMatchesRules(addressable);

		service.setSelection({ kind: 'string', address: '0x4a201c' });
		const onString = enabled();
		service.setSelection({ kind: 'xref' });
		const onXref = enabled();

		assert.deepStrictEqual({ onString, onXref }, { onString: true, onXref: false });
	});

	test('the address is published in wire form and cleared with the selection', () => {
		const { service } = selectionService();
		const seen: IDelverSelection[] = [];
		disposables.add(service.onDidChangeSelection(selection => seen.push(selection)));

		// Above 2^53: the reason the key carries the "0x..." string rather than a
		// number, per invariant 2.
		service.setSelection({ kind: 'function', address: '0x1ffffffffffffff' });
		service.setSelection({ kind: 'function', address: '0x1ffffffffffffff' });
		service.setSelection(DELVER_SELECTION_NONE);

		assert.deepStrictEqual(seen, [
			// The repeat is coalesced: re-reporting an unchanged selection would
			// churn every `when` clause in the workbench for nothing.
			{ kind: 'function', address: '0x1ffffffffffffff' },
			{ kind: 'none' },
		]);
	});
});
