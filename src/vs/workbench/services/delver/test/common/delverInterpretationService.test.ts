/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IDelverInterpretationStoreService,
	IInterpretationEditRequestWire,
	IInterpretationEditWire,
} from '../../../../../platform/delver/common/delverInterpretationStoreService.js';
import { EditOp, EditStatus, IAuthor } from '../../../../../platform/delver/common/interpretation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DELVER_AUTO_REVIEWER, DELVER_REVIEW_MODE_SETTING } from '../../common/delverReviewPolicy.js';
import { DelverInterpretationService } from '../../common/delverInterpretationService.js';

const HASH = 'a'.repeat(64);

const ANALYST: IAuthor = { kind: 'human', id: 'analyst' };
const MODEL: IAuthor = { kind: 'model', id: 'opus-5' };

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

	async append(_contentHash: string, edit: IInterpretationEditRequestWire, minimumSeq = 1): Promise<IInterpretationEditWire> {
		// Allocates the way the shared-process store does: above everything held,
		// and above the floor the caller knows about.
		const seq = Math.max(minimumSeq, this.persisted.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1);
		const sequenced: IInterpretationEditWire = { seq, ...edit };
		this.persisted.push(sequenced);
		return sequenced;
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

/**
 * Configuration stub selecting a review mode.
 *
 * Defaults to `manual`, which is the product default too, so every test
 * written before automatic review existed keeps asserting the behaviour it was
 * written for.
 */
function reviewMode(mode: 'manual' | 'auto' = 'manual'): IConfigurationService {
	return { getValue: (key?: string) => (key === DELVER_REVIEW_MODE_SETTING ? mode : undefined) } as unknown as IConfigurationService;
}

suite('DelverInterpretationService persistence', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('automatic review records who accepted, and never that a person did', async () => {
		// The mode exists so an analyst driving an agent is not made to click
		// four hundred times. What it must not do is make the log — or anything
		// reading it — say a human agreed. The proposal is still appended as a
		// proposal and then resolved by a second, rule-authored record, so "a
		// model claimed this" and "a policy accepted it" stay separate facts.
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode('auto')));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000n };
		await service.load(HASH);

		const returned = await service.propose(anchor, EditOp.Rename, 'decode_config', MODEL);

		// Scoped to this anchor: the fake store seeds an unrelated edit, and the
		// claim here is about the pair of records one proposal produces.
		const written = service.logFor(HASH).filter(edit => edit.anchor.kind === 'image' && edit.anchor.rva === anchor.rva);
		assert.deepStrictEqual({
			log: written.map(edit => ({ status: edit.status, author: edit.author, resolves: edit.resolves?.length })),
			// The value stands, which is the point of the mode.
			applied: service.nameAt(anchor),
			// Nothing is left waiting, so the review view is not quietly filling
			// with work nobody intends to do.
			pending: service.pendingProposals(HASH).length,
			// The caller is handed the record that actually stands, not the
			// superseded proposal, so an agent reporting what it did is right.
			returnedStatus: returned.status,
		}, {
			log: [
				{ status: 'proposed', author: MODEL, resolves: undefined },
				// Resolving exactly the proposal above it — the link is what lets
				// a reader see that a policy decided a model's claim, rather
				// than finding an accepted edit with no account of how it got
				// that way.
				{ status: 'accepted', author: DELVER_AUTO_REVIEWER, resolves: 1 },
			],
			applied: 'decode_config',
			pending: 0,
			returnedStatus: 'accepted',
		});
	});

	test('manual review is the default, including for a value nobody recognises', async () => {
		// Failing closed matters here because the two directions are not
		// symmetric: defaulting to manual costs clicking, defaulting to auto
		// accepts a model's claims nobody asked it to accept. A typo in settings
		// must not be a way to arrive at the permissive mode.
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(
			persistence as unknown as IDelverInterpretationStoreService,
			{ getValue: () => 'automatic' } as unknown as IConfigurationService,
		));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000n };
		await service.load(HASH);

		await service.propose(anchor, EditOp.Rename, 'decode_config', MODEL);

		assert.deepStrictEqual({
			pending: service.pendingProposals(HASH).length,
			applied: service.nameAt(anchor),
		}, {
			pending: 1,
			applied: undefined,
		});
	});

	test('replays before reads and persists before announcing an edit', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
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
				// Narrowed rather than asserted through: the wire anchor is a union
				// now, and a test that reached past that would stop proving the
				// image case is the one being persisted.
				wireRva: (() => {
					const anchor = persistence.persisted[1].anchor;
					return anchor.kind === 'image' ? anchor.rva : undefined;
				})(),
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

	test('two services over one store never mint the same sequence', async () => {
		// The defect this guards: each service replays the same stored log, so
		// both reach the same next number in memory. Whichever write lands second
		// then collides with the first, and the store that resolves the collision
		// by ignoring it loses an authored edit while reporting success.
		const persistence = new FakeStore();
		const first = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		const second = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x4000n };
		await first.load(HASH);
		await second.load(HASH);

		const fromFirst = await first.edit(anchor, EditOp.Rename, 'first_window');
		const fromSecond = await second.edit(anchor, EditOp.Rename, 'second_window');

		assert.deepStrictEqual({
			seqs: [fromFirst.seq, fromSecond.seq],
			persisted: persistence.persisted.map(edit => ({ seq: edit.seq, value: edit.value })),
		}, {
			seqs: [8, 9],
			persisted: [
				{ seq: 7, value: 'loaded_name' },
				{ seq: 8, value: 'first_window' },
				{ seq: 9, value: 'second_window' },
			],
		});
	});

	test('undo appends compensations and continues backward through local history', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
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

	test('redo takes an undo back, and undo then continues further into history', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000000000000001n };
		await service.edit(anchor, EditOp.Rename, 'first');
		await service.edit(anchor, EditOp.Rename, 'second');

		await service.undoLast(HASH);
		const names: string[] = [service.nameAt(anchor)!];
		await service.redoLast(HASH);
		names.push(service.nameAt(anchor)!);
		// The redone undo must not still suppress 'first', or this finds nothing.
		await service.undoLast(HASH);
		names.push(service.nameAt(anchor)!);
		await service.undoLast(HASH);
		names.push(service.nameAt(anchor)!);

		assert.deepStrictEqual(names, ['first', 'second', 'first', 'loaded_name']);
	});

	test('redo reports nothing to take back when no undo is standing', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x1000000000000001n };
		await service.edit(anchor, EditOp.Rename, 'first');

		const beforeAnyUndo = await service.redoLast(HASH);
		await service.undoLast(HASH);
		await service.redoLast(HASH);
		const afterRedoing = await service.redoLast(HASH);

		assert.deepStrictEqual(
			{ beforeAnyUndo, afterRedoing, name: service.nameAt(anchor) },
			{ beforeAnyUndo: undefined, afterRedoing: undefined, name: 'first' },
		);
	});

	test('revert author restores every affected field without removing other authors', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
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
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
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

	test('a proposal is persisted and pending until a reviewer decides it', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		const anchor = { kind: 'image' as const, contentHash: HASH, rva: 0x2000n };
		await service.load(HASH);

		const proposal = await service.propose(anchor, EditOp.Rename, 'decrypt_config', MODEL);
		const pendingBefore = service.pendingProposals(HASH).map(edit => edit.seq);
		const [decision] = await service.resolveProposals(HASH, [proposal.seq], EditStatus.Accepted, ANALYST);

		assert.deepStrictEqual({
			pendingBefore,
			nameBefore: undefined,
			pendingAfter: service.pendingProposals(HASH).length,
			name: service.nameAt(anchor),
			decidedBy: decision.author.id,
			resolves: decision.resolves,
			persistedStatuses: persistence.persisted.map(edit => edit.status),
			persistedResolves: persistence.persisted.map(edit => edit.resolves),
		}, {
			pendingBefore: [8],
			nameBefore: undefined,
			pendingAfter: 0,
			name: 'decrypt_config',
			decidedBy: 'analyst',
			resolves: [8],
			persistedStatuses: [EditStatus.Accepted, EditStatus.Proposed, EditStatus.Accepted],
			persistedResolves: [undefined, undefined, [8]],
		});
	});

	test('an invalid review batch appends no resolutions', async () => {
		const persistence = new FakeStore();
		const service = store.add(new DelverInterpretationService(persistence as unknown as IDelverInterpretationStoreService, reviewMode()));
		await service.load(HASH);

		const first = await service.propose({ kind: 'image', contentHash: HASH, rva: 0x2000n }, EditOp.Rename, 'first', MODEL);
		const second = await service.propose({ kind: 'image', contentHash: HASH, rva: 0x3000n }, EditOp.Rename, 'second', MODEL);
		const persistedBefore = persistence.persisted.length;

		let failure = 'accepted';
		try {
			// The second sequence is not a proposal, so nothing may be appended.
			await service.resolveProposals(HASH, [first.seq, 7], EditStatus.Accepted, ANALYST);
		} catch (error) {
			failure = (error as Error).message;
		}
		const rejected = await service.resolveProposals(HASH, [first.seq, second.seq], EditStatus.Rejected, ANALYST);

		assert.deepStrictEqual({
			failure,
			persistedAfterFailure: persistedBefore,
			appendedByFailure: persistence.persisted.length - persistedBefore - rejected.length,
			pending: service.pendingProposals(HASH).length,
			names: [service.nameAt({ kind: 'image', contentHash: HASH, rva: 0x2000n }), service.nameAt({ kind: 'image', contentHash: HASH, rva: 0x3000n })],
			outcomes: rejected.map(edit => edit.status),
		}, {
			failure: 'Interpretation edit 7 is not a proposal',
			persistedAfterFailure: 3,
			appendedByFailure: 0,
			pending: 0,
			names: [undefined, undefined],
			outcomes: [EditStatus.Rejected, EditStatus.Rejected],
		});
	});
});
