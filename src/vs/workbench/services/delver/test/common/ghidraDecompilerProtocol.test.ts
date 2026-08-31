/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decodeGhidraDecompilerOutput, DelverDecompilerOutputError } from '../../common/ghidraDecompilerProtocol.js';

suite('GhidraDecompilerProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes the versioned wire format without losing RVA precision', () => {
		const result = decodeGhidraDecompilerOutput(JSON.stringify({
			schemaVersion: 1,
			functionRva: '0x20000000000001',
			text: 'int entry(void) {\n\treturn 0;\n}',
			lineMappings: [{
				line: 2,
				ranges: [
					{ startRva: '0x20000000000001', endRva: '0x20000000000005' },
					{ startRva: '0x20000000000010', endRva: '0x20000000000012' },
				],
			}],
			variables: [{ name: 'result', typeName: 'int', storage: 'RAX', declarationLine: 1 }],
		}), 0x20000000000001n);

		assert.deepStrictEqual(result, {
			backendId: 'ghidra-headless',
			functionRva: 0x20000000000001n,
			text: 'int entry(void) {\n\treturn 0;\n}',
			lineMappings: [{
				line: 2,
				ranges: [
					{ startRva: 0x20000000000001n, endRva: 0x20000000000005n },
					{ startRva: 0x20000000000010n, endRva: 0x20000000000012n },
				],
			}],
			variables: [{ name: 'result', typeName: 'int', storage: 'RAX', declarationLine: 1 }],
		});
	});

	test('decodes a canonical accepted semantic snapshot', () => {
		const semanticDependencies = {
			schemaVersion: 1 as const,
			dataTypes: [{ rva: '0x3000', declaration: 'uint32_t' }],
			functionPrototypes: [{ rva: '0x1000', declaration: 'int entry(uint32_t flags)' }],
		};
		const result = decodeGhidraDecompilerOutput(JSON.stringify({
			schemaVersion: 1,
			functionRva: '0x1000',
			text: 'int entry(uint32_t flags) { return flags; }',
			lineMappings: [],
			variables: [],
			semanticDependencies,
		}), 0x1000n);

		// Normalized up, not echoed back: a v1 snapshot *is* a v2 one with no
		// composites, and reading it as v1 would make every function saved
		// before composites existed compare as stale on first open.
		assert.deepStrictEqual(result.semanticDependencies, {
			schemaVersion: 2,
			composites: [],
			dataTypes: semanticDependencies.dataTypes,
			functionPrototypes: semanticDependencies.functionPrototypes,
		});
	});

	test('reads back every composite kind, each by its own shape', () => {
		// Saved pseudocode carries the snapshot it was produced against, and it
		// is read back through here. A union whose members all sit at offset 0
		// is the case that a struct-shaped reader rejects outright, which would
		// make every function saved against a union unreadable.
		const semanticDependencies = {
			schemaVersion: 2 as const,
			composites: [
				{ name: 'Command', kind: 'enum' as const, size: 4, members: [{ name: 'CMD_EXEC', value: 2 }, { name: 'CMD_PING', value: 1 }] },
				{ name: 'Config', kind: 'struct' as const, size: 8, fields: [{ offset: 0, name: 'flags', type: 'uint32_t' }] },
				{ name: 'Overlay', kind: 'union' as const, size: 8, fields: [
					{ offset: 0, name: 'as_bytes', type: 'char[8]' },
					{ offset: 0, name: 'as_handle', type: 'void *' },
				] },
			],
			dataTypes: [],
			functionPrototypes: [],
		};

		const result = decodeGhidraDecompilerOutput(JSON.stringify({
			schemaVersion: 1,
			functionRva: '0x1000',
			text: 'void entry(void) {}',
			lineMappings: [],
			variables: [],
			semanticDependencies,
		}), 0x1000n);

		assert.deepStrictEqual(result.semanticDependencies, semanticDependencies);
	});

	test('refuses a composite whose members contradict its kind', () => {
		const snapshot = (composite: unknown) => JSON.stringify({
			schemaVersion: 1,
			functionRva: '0x1000',
			text: '',
			lineMappings: [],
			variables: [],
			semanticDependencies: { schemaVersion: 2, composites: [composite], dataTypes: [], functionPrototypes: [] },
		});
		const refused = [
			// A union member somewhere other than the start.
			{ name: 'Overlay', kind: 'union', size: 8, fields: [{ offset: 4, name: 'tail', type: 'uint32_t' }] },
			// A struct with two fields at one offset.
			{ name: 'Config', kind: 'struct', size: 8, fields: [
				{ offset: 0, name: 'a', type: 'uint32_t' },
				{ offset: 0, name: 'b', type: 'uint32_t' },
			] },
			// An enum carrying storage, or a width it cannot cross the wire in.
			{ name: 'Command', kind: 'enum', size: 4, fields: [] },
			{ name: 'Command', kind: 'enum', size: 8, members: [] },
			{ name: 'Command', kind: 'enum', size: 4, members: [{ name: 'B', value: 2 }, { name: 'A', value: 1 }] },
			// A kind this build does not know.
			{ name: 'Bits', kind: 'bitfield', size: 4, fields: [] },
		];

		assert.deepStrictEqual(
			refused.map(composite => {
				try {
					decodeGhidraDecompilerOutput(snapshot(composite), 0x1000n);
					return 'accepted';
				} catch {
					return 'refused';
				}
			}),
			refused.map(() => 'refused'),
		);
	});

	test('rejects malformed and incompatible responses', () => {
		const responses = [
			'not json',
			JSON.stringify({ schemaVersion: 2, functionRva: '0x1000', text: '', lineMappings: [], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '1000', text: '', lineMappings: [], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [], extra: true }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [{ line: 0, ranges: [] }], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [{ line: 1, ranges: [{ startRva: '0x20', endRva: '0x20' }] }], variables: [] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [{ name: '' }] }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [], semanticDependencies: { schemaVersion: 2, dataTypes: [], functionPrototypes: [] } }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [], semanticDependencies: { schemaVersion: 1, dataTypes: [{ rva: '0x02', declaration: 'int' }], functionPrototypes: [] } }),
			JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: '', lineMappings: [], variables: [], semanticDependencies: { schemaVersion: 1, dataTypes: [{ rva: '0x20', declaration: 'int' }, { rva: '0x10', declaration: 'char' }], functionPrototypes: [] } }),
		];

		for (const response of responses) {
			assert.throws(() => decodeGhidraDecompilerOutput(response, 0x1000n), DelverDecompilerOutputError);
		}
	});

	test('rejects output for a different function', () => {
		assert.throws(
			() => decodeGhidraDecompilerOutput(JSON.stringify({
				schemaVersion: 1,
				functionRva: '0x1001',
				text: '',
				lineMappings: [],
				variables: [],
			}), 0x1000n),
			DelverDecompilerOutputError,
		);
	});
});
