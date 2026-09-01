/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditOp } from '../../../../../platform/delver/common/interpretation.js';
import { declarationPlacementRefusal, interpretationEditValue, interpretationRvaFromHandle, parseTags } from '../../../../services/delver/browser/delverInterpretationEditing.js';
import { parseTypeProposals } from '../../../../services/delver/common/delverAgentProposalParsing.js';
import { typePlacementFacts, typePlacementRefusal } from '../../../../services/delver/common/delverTypePlacement.js';
import { IDelverSessionService } from '../../../../services/delver/common/delverSessionService.js';
import { IFunctionWire, IGetImageInfoResult } from '../../../../../platform/delver/common/protocol.generated.js';

/** One image with a code section and a data section, enough for both rules. */
const PLACEMENT_IMAGE = {
	sections: [
		{ name: '.text', virtual_address: '0x1000', virtual_size: 0x300, executable: true },
		{ name: '.data', virtual_address: '0x2000', virtual_size: 0x200, executable: false },
	],
} as unknown as IGetImageInfoResult;

const PLACEMENT_FUNCTIONS = [{ rva: '0x1000', authoritative: true }] as unknown as readonly IFunctionWire[];

/** Only the two reads a placement check makes; nothing else is exercised. */
const PLACEMENT_SESSION = {
	imageInfo: async () => PLACEMENT_IMAGE,
	functions: async () => ({ functions: PLACEMENT_FUNCTIONS }),
} as unknown as IDelverSessionService;

suite('Delver interpretation editing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tag input is trimmed, deduplicated, and sorted for persistence', () => {
		assert.deepStrictEqual(parseTags(' review,crypto, review, ,config '), ['config', 'crypto', 'review']);
	});

	test('an authored declaration stores exactly what the same model proposal would', () => {
		const authored = [
			{ op: EditOp.DataType, rva: 0x1000n, declaration: interpretationEditValue(EditOp.DataType, '  char[32]  ') },
			{ op: EditOp.FunctionPrototype, rva: 0x2000n, declaration: interpretationEditValue(EditOp.FunctionPrototype, '  int __fastcall decode(char *buffer)  ') },
		];
		assert.deepStrictEqual(authored, parseTypeProposals([
			{ address: '0x1000', target: 'data', declaration: '  char[32]  ' },
			{ address: '0x2000', target: 'function', declaration: '  int __fastcall decode(char *buffer)  ' },
		]));
	});

	test('a declaration the proposal path would refuse is refused when authored too', () => {
		const overlong = 'a'.repeat(2049);
		assert.throws(() => interpretationEditValue(EditOp.DataType, overlong), /must not exceed 2048 characters/);
		assert.throws(() => parseTypeProposals([{ address: '0x1000', target: 'data', declaration: overlong }]), /must not exceed 2048 characters/);
	});

	test('realistic MSVC declarations survive the guard unchanged', () => {
		const declarations = [
			'char[32]',
			'unsigned __int64',
			'struct _IMAGE_DOS_HEADER *',
			'const wchar_t *[MAX_PATH]',
			'BYTE[SIZE * 2]',
			'void (__stdcall *callback)(void *context, unsigned long status)',
			'int __fastcall decode(char *buffer, unsigned int length)',
			'struct { int a; int b; } *',
			'',
		];
		assert.deepStrictEqual(
			declarations.map(declaration => interpretationEditValue(EditOp.DataType, declaration)),
			declarations,
		);
	});

	test('declarations that are not declarations are refused before they are stored', () => {
		const malformed = [
			'))))',
			'*char',
			'32',
			'struct Config *(',
			'char[32',
			'char[)]',
			'int foo(char *a]',
			'char\u0000[4]',
		];
		assert.deepStrictEqual(
			malformed.map(declaration => {
				try {
					interpretationEditValue(EditOp.DataType, declaration);
					return 'accepted';
				} catch {
					return 'refused';
				}
			}),
			malformed.map(() => 'refused'),
		);
	});

	test('the analyst and the model agree on where a declaration may attach', async () => {
		const facts = typePlacementFacts(PLACEMENT_IMAGE, PLACEMENT_FUNCTIONS);
		const rows = [
			{ op: EditOp.DataType, rva: 0x2000n, declaration: 'char[32]' },
			{ op: EditOp.DataType, rva: 0x1000n, declaration: 'char[32]' },
			{ op: EditOp.DataType, rva: 0x9000n, declaration: 'char[32]' },
			{ op: EditOp.DataType, rva: 0x1000n, declaration: '' },
			{ op: EditOp.FunctionPrototype, rva: 0x1000n, declaration: 'void f(void)' },
			{ op: EditOp.FunctionPrototype, rva: 0x1004n, declaration: 'void f(void)' },
			{ op: EditOp.FunctionPrototype, rva: 0x2000n, declaration: 'void f(void)' },
		];
		const decisions = [];
		for (const row of rows) {
			decisions.push({
				model: typePlacementRefusal(row.op, row.rva, row.declaration, facts) === undefined ? 'accepted' : 'refused',
				human: await declarationPlacementRefusal(PLACEMENT_SESSION, row.op, row.rva, row.declaration) === undefined ? 'accepted' : 'refused',
			});
		}
		assert.deepStrictEqual(decisions, [
			{ model: 'accepted', human: 'accepted' },
			{ model: 'refused', human: 'refused' },
			{ model: 'refused', human: 'refused' },
			{ model: 'accepted', human: 'accepted' },
			{ model: 'accepted', human: 'accepted' },
			{ model: 'refused', human: 'refused' },
			{ model: 'refused', human: 'refused' },
		]);
	});

	test('actionable view handles preserve a wire-safe 64-bit RVA', () => {
		assert.strictEqual(
			interpretationRvaFromHandle('delver.import.symbol.2.7.0x1000000000000001'),
			0x1000000000000001n,
		);
		assert.strictEqual(interpretationRvaFromHandle('delver.export.3.forwarded'), undefined);
	});
});
