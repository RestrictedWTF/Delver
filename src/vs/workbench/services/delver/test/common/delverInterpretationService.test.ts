/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IDelverInterpretationStoreService,
	IInterpretationEditWire,
} from '../../../../../platform/delver/common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../../../../../platform/delver/common/interpretation.js';
import { DelverInterpretationService } from '../../common/delverInterpretationService.js';

const HASH = 'a'.repeat(64);

class FakeStore implements Partial<IDelverInterpretationStoreService> {
	readonly persisted: IInterpretationEditWire[] = [{
		seq: 7,
		at: 100,
		author: { kind: 'human', id: 'earlier' },
		anchor: { kind: 'image', contentHash: HASH, rva: '0x1000000000000001' },
		op: EditOp.Rename,
		value: 'loaded_name',
		status: EditStatus.Accepted,
	}];

	async load(): Promise<readonly IInterpretationEditWire[]> {
		return this.persisted;
	}

	async append(_contentHash: string, edit: IInterpretationEditWire): Promise<void> {
		this.persisted.push(edit);
	}

	async importLog(contentHash: string): Promise<readonly IInterpretationEditWire[]> {
		const imported: IInterpretationEditWire = {
			seq: 2,
			at: 200,
			author: { kind: 'human', id: 'shared-analyst' },
			anchor: { kind: 'image', contentHash, rva: '0x2000' },
			op: EditOp.Comment,
			value: 'imported comment',
			status: EditStatus.Accepted,
		};
		this.persisted.push(imported);
		return [imported];
	}
}

suite('DelverInterpretationService persistence', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('replays before reads and persists before announcing an edit', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000000000000001n };
		await service.load(HASH);

		const announced: string[] = [];
		store.add(service.onDidChange(event => announced.push(String(event.edit.value))));
		const saved = await service.edit(anchor, EditOp.Rename, 'new_name');

		assert.deepStrictEqual(
			{
				loaded: service.logFor(HASH)[0].value,
				current: service.nameAt(anchor),
				seq: saved.seq,
				wireRva: persistence.persisted[1].anchor.rva,
				announced,
			},
			{
				loaded: 'loaded_name',
				current: 'new_name',
				seq: 8,
				wireRva: '0x1000000000000001',
				announced: ['new_name'],
			},
		);
	});

	test('undo appends compensations and continues backward through local history', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000000000000001n };
		await service.edit(anchor, EditOp.Rename, 'first');
		await service.edit(anchor, EditOp.Rename, 'second');

		const firstUndo = await service.undoLast(HASH);
		const secondUndo = await service.undoLast(HASH);

		assert.deepStrictEqual(
			{
				name: service.nameAt(anchor),
				values: service.logFor(HASH).map(edit => edit.value),
				compensates: [firstUndo?.compensates, secondUndo?.compensates],
			},
			{
				name: 'loaded_name',
				values: ['loaded_name', 'first', 'second', 'first', 'loaded_name'],
				compensates: [[9], [8]],
			},
		);
	});

	test('revert author restores every affected field without removing other authors', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x3000n };
		const model = { kind: 'model' as const, id: 'assistant' };
		await service.edit(anchor, EditOp.Rename, 'model_name', model);
		await service.edit(anchor, EditOp.Comment, 'model comment', model);
		await service.edit(anchor, EditOp.Tags, ['crypto', 'review'], model);
		await service.edit(anchor, EditOp.Comment, 'analyst correction');

		const count = await service.revertAuthor(HASH, model);

		assert.deepStrictEqual(
			{
				count,
				current: service.at(anchor),
				compensations: service.logFor(HASH).slice(-3).map(edit => edit.compensates),
			},
			{
				count: 3,
				current: { comment: 'analyst correction' },
				compensations: [[8], [9], [10]],
			},
		);
	});

	test('import appends and materializes the shared edits', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService));
		const announced: string[] = [];
		store.add(service.onDidChange(event => announced.push(event.edit.author.id)));

		const count = await service.importFrom(HASH, 'C:\\shared.delverdb');

		assert.deepStrictEqual(
			{
				count,
				comment: service.at({ kind: 'image', contentHash: HASH, rva: 0x2000n })?.comment,
				logged: service.logFor(HASH).length,
				announced,
			},
			{
				count: 1,
				comment: 'imported comment',
				logged: 2,
				announced: ['shared-analyst'],
			},
		);
	});
});
