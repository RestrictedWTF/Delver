/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IInterpretationEditWire } from '../../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../../common/interpretation.js';
import { DelverInterpretationStoreService } from '../../node/delverInterpretationStoreService.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function edit(contentHash: string, seq: number, rva = '0x1000000000000001'): IInterpretationEditWire {
	return {
		seq,
		at: 1_700_000_000_000 + seq,
		author: { kind: 'human', id: 'analyst' },
		anchor: { kind: 'image', contentHash, rva },
		op: EditOp.Rename,
		value: `name_${seq}`,
		status: EditStatus.Accepted,
	};
}

suite('DelverInterpretationStoreService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let userDataPath: string;
	let service: DelverInterpretationStoreService;

	setup(async () => {
		userDataPath = await promises.mkdtemp(join(tmpdir(), 'delver-interpretation-test-'));
		service = new DelverInterpretationStoreService({ userDataPath } as unknown as INativeEnvironmentService);
	});

	teardown(async () => {
		await promises.rm(userDataPath, { recursive: true, force: true });
	});

	test('appends one wire-safe JSON line per edit and replays it', async () => {
		await Promise.all([
			service.append(HASH_A, edit(HASH_A, 1)),
			service.append(HASH_A, edit(HASH_A, 2, '0xffffffffffffffff')),
		]);

		const path = join(userDataPath, 'delver', 'interpretation', `${HASH_A}.delverdb`);
		const contents = await promises.readFile(path, 'utf8');
		assert.deepStrictEqual(
			{ edits: await service.load(HASH_A), lines: contents.trimEnd().split('\n').length },
			{ edits: [edit(HASH_A, 1), edit(HASH_A, 2, '0xffffffffffffffff')], lines: 2 },
		);
	});

	test('a truncated final append costs only that edit and the log remains appendable', async () => {
		await service.append(HASH_A, edit(HASH_A, 1));
		const path = join(userDataPath, 'delver', 'interpretation', `${HASH_A}.delverdb`);
		await promises.appendFile(path, '{"seq":2', 'utf8');

		assert.deepStrictEqual(await service.load(HASH_A), [edit(HASH_A, 1)]);
		await service.append(HASH_A, edit(HASH_A, 3));
		assert.deepStrictEqual(await service.load(HASH_A), [edit(HASH_A, 1), edit(HASH_A, 3)]);
	});

	test('export and import preserve attribution and reject different bytes', async () => {
		await service.append(HASH_A, edit(HASH_A, 1));
		const exported = join(userDataPath, 'shared.delverlog');
		assert.strictEqual(await service.exportLog(HASH_A, exported), 1);

		const importedUserData = join(userDataPath, 'second-profile');
		const imported = new DelverInterpretationStoreService({ userDataPath: importedUserData } as unknown as INativeEnvironmentService);
		assert.deepStrictEqual(await imported.importLog(HASH_A, exported), [edit(HASH_A, 1)]);
		assert.deepStrictEqual(await imported.load(HASH_A), [edit(HASH_A, 1)]);
		await assert.rejects(() => imported.importLog(HASH_B, exported), /line 1/);
	});

	test('rejects a SQLite project as an interpretation log', async () => {
		const source = join(userDataPath, 'project.delverdb');
		await promises.writeFile(source, 'SQLite format 3\0project data', 'utf8');
		await assert.rejects(
			() => service.importLog(HASH_A, source),
			/Select a \.delverlog file instead/,
		);
	});

	test('merged imports are resequenced with compensation references intact', async () => {
		await service.append(HASH_A, edit(HASH_A, 7));
		const source = join(userDataPath, 'compensated.delverlog');
		const original = [
			{ ...edit(HASH_A, 1), op: EditOp.Tags, value: ['crypto'] },
			{ ...edit(HASH_A, 2), op: EditOp.Tags, value: [], compensates: [1] },
		];
		await promises.writeFile(source, original.map(value => `${JSON.stringify(value)}\n`).join(''), 'utf8');

		const imported = await service.importLog(HASH_A, source);

		assert.deepStrictEqual(
			imported.map(value => ({ seq: value.seq, compensates: value.compensates })),
			[{ seq: 8, compensates: undefined }, { seq: 9, compensates: [8] }],
		);
	});

	test('resolution references survive a merged import and a malformed one is refused', async () => {
		await service.append(HASH_A, edit(HASH_A, 7));
		const source = join(userDataPath, 'reviewed.delverlog');
		const original = [
			{ ...edit(HASH_A, 1), value: 'proposed_name', status: EditStatus.Proposed, author: { kind: 'model', id: 'opus-5' } },
			{ ...edit(HASH_A, 2), value: 'proposed_name', resolves: [1] },
		];
		await promises.writeFile(source, original.map(value => `${JSON.stringify(value)}
`).join(''), 'utf8');
		const malformed = join(userDataPath, 'malformed.delverlog');
		await promises.writeFile(malformed, `${JSON.stringify({ ...edit(HASH_A, 1), resolves: [0] })}
`, 'utf8');

		const imported = await service.importLog(HASH_A, source);
		const refused = await service.importLog(HASH_A, malformed).then(() => 'accepted', error => (error as Error).message);

		assert.deepStrictEqual({
			imported: imported.map(value => ({ seq: value.seq, status: value.status, resolves: value.resolves })),
			refused: refused.startsWith('Invalid interpretation log'),
		}, {
			imported: [
				{ seq: 8, status: EditStatus.Proposed, resolves: undefined },
				{ seq: 9, status: EditStatus.Accepted, resolves: [8] },
			],
			refused: true,
		});
	});
});
