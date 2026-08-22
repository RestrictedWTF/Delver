/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	Anchor,
	EditOp,
	EditStatus,
	IAuthor,
	InterpretationLog,
} from '../../common/interpretation.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const ANALYST: IAuthor = { kind: 'human', id: 'analyst' };
const MODEL: IAuthor = { kind: 'model', id: 'claude' };

function at(rva: bigint, contentHash = HASH_A): Anchor {
	return { kind: 'image', contentHash, rva };
}

suite('InterpretationLog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a name is readable at the anchor it was authored against', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'decrypt_config' });

		assert.strictEqual(log.nameAt(at(0x1000n)), 'decrypt_config');
	});

	test('the same address in a different image is a different anchor', () => {
		// The whole reason anchors carry a content hash. Two binaries sharing an
		// address must never share a name.
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n, HASH_A), op: EditOp.Rename, value: 'from_a' });

		assert.strictEqual(log.nameAt(at(0x1000n, HASH_B)), undefined);
	});

	test('nothing is overwritten — a rename appends', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'first' });
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'second' });

		assert.deepStrictEqual(
			{ current: log.nameAt(at(0x1000n)), history: log.log.map(e => e.value) },
			{ current: 'second', history: ['first', 'second'] },
		);
	});

	test('every edit carries its author', () => {
		// An unattributed edit is indistinguishable from a fact, which is the
		// confusion this layer exists to prevent.
		const log = new InterpretationLog();
		log.append({ author: MODEL, anchor: at(0x1000n), op: EditOp.Rename, value: 'guessed' });

		assert.deepStrictEqual(log.log[0].author, MODEL);
	});

	test('a proposed edit is recorded but not yet part of the picture', () => {
		const log = new InterpretationLog();
		log.append({
			author: MODEL,
			anchor: at(0x1000n),
			op: EditOp.Rename,
			value: 'maybe_decrypt',
			status: EditStatus.Proposed,
		});

		assert.deepStrictEqual(
			{ name: log.nameAt(at(0x1000n)), logged: log.log.length },
			{ name: undefined, logged: 1 },
			'a model\'s suggestion must be reviewable without being mistaken for fact'
		);
	});

	test('clearing a name is an append, not a deletion', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'wrong' });
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: '' });

		assert.deepStrictEqual(
			{ name: log.nameAt(at(0x1000n)), logged: log.log.length },
			{ name: undefined, logged: 2 },
		);
	});

	test('names and comments at one anchor do not displace each other', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'stage2' });
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Comment, value: 'RC4, key at 0x4000' });

		assert.deepStrictEqual(log.at(at(0x1000n)), { name: 'stage2', comment: 'RC4, key at 0x4000' });
	});

	test('tags are a canonical set-valued field and replay independently', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'stage2' });
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Tags, value: ['crypto', 'config'] });

		assert.deepStrictEqual(
			InterpretationLog.from(log.log).at(at(0x1000n)),
			{ name: 'stage2', tags: ['crypto', 'config'] },
		);
	});

	test('replaying the log reconstructs the same state', () => {
		// The log is the truth and the materialized view is a cache; this is what
		// makes the cache safe to discard, and what loading a stored log relies on.
		const original = new InterpretationLog();
		original.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'first' });
		original.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'second' });
		original.append({ author: ANALYST, anchor: at(0x2000n), op: EditOp.Comment, value: 'entry thunk' });

		const replayed = InterpretationLog.from(original.log);

		assert.deepStrictEqual(
			{
				a: replayed.at(at(0x1000n)),
				b: replayed.at(at(0x2000n)),
				seqs: replayed.log.map(e => e.seq),
			},
			{
				a: { name: 'second' },
				b: { comment: 'entry thunk' },
				seqs: [1, 2, 3],
			},
		);
	});

	test('a replayed log continues numbering rather than colliding', () => {
		const original = new InterpretationLog();
		original.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'x' });

		const replayed = InterpretationLog.from(original.log);
		const next = replayed.append({ author: ANALYST, anchor: at(0x2000n), op: EditOp.Rename, value: 'y' });

		assert.strictEqual(next.seq, 2);
	});

	test('a proposal is visible in the log and absent from the picture', () => {
		const log = new InterpretationLog();
		const proposal = log.append({ author: MODEL, anchor: at(0x1000n), op: EditOp.Rename, value: 'decrypt_config', status: EditStatus.Proposed });

		assert.deepStrictEqual({
			name: log.nameAt(at(0x1000n)),
			logged: log.log.length,
			pending: log.pendingProposals().map(edit => edit.seq),
			resolved: log.isResolved(proposal.seq),
		}, {
			name: undefined,
			logged: 1,
			pending: [1],
			resolved: false,
		});
	});

	test('accepting a proposal appends the reviewer\'s decision and keeps the proposal traceable', () => {
		const log = new InterpretationLog();
		const proposal = log.append({ author: MODEL, anchor: at(0x1000n), op: EditOp.Rename, value: 'decrypt_config', status: EditStatus.Proposed });
		const decision = log.append(log.resolutionOf(proposal.seq, EditStatus.Accepted, ANALYST));

		assert.deepStrictEqual({
			name: log.nameAt(at(0x1000n)),
			decidedBy: decision.author,
			resolves: decision.resolves,
			proposedBy: log.editAt(decision.resolves![0])?.author,
			pending: log.pendingProposals().length,
		}, {
			name: 'decrypt_config',
			decidedBy: ANALYST,
			resolves: [1],
			proposedBy: MODEL,
			pending: 0,
		});
	});

	test('rejecting a proposal records what was declined without touching the picture', () => {
		const log = new InterpretationLog();
		log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'authored' });
		const proposal = log.append({ author: MODEL, anchor: at(0x1000n), op: EditOp.Rename, value: 'guessed', status: EditStatus.Proposed });
		const decision = log.append(log.resolutionOf(proposal.seq, EditStatus.Rejected, ANALYST));

		assert.deepStrictEqual({
			name: log.nameAt(at(0x1000n)),
			status: decision.status,
			declined: decision.value,
			pending: log.pendingProposals().length,
			resolved: log.isResolved(proposal.seq),
		}, {
			name: 'authored',
			status: EditStatus.Rejected,
			declined: 'guessed',
			pending: 0,
			resolved: true,
		});
	});

	test('a decided, unknown, or non-proposed sequence cannot be resolved', () => {
		const log = new InterpretationLog();
		const accepted = log.append({ author: ANALYST, anchor: at(0x1000n), op: EditOp.Rename, value: 'authored' });
		const proposal = log.append({ author: MODEL, anchor: at(0x2000n), op: EditOp.Rename, value: 'guessed', status: EditStatus.Proposed });
		log.append(log.resolutionOf(proposal.seq, EditStatus.Accepted, ANALYST));

		assert.deepStrictEqual([
			() => log.resolutionOf(99, EditStatus.Accepted, ANALYST),
			() => log.resolutionOf(accepted.seq, EditStatus.Accepted, ANALYST),
			() => log.resolutionOf(proposal.seq, EditStatus.Rejected, ANALYST),
		].map(resolve => {
			try {
				resolve();
				return 'accepted';
			} catch (error) {
				return (error as Error).message;
			}
		}), [
			'No interpretation edit at sequence 99',
			'Interpretation edit 1 is not a proposal',
			'Proposal 2 has already been decided',
		]);
	});

	test('replay restores pending proposals and decisions', () => {
		const original = new InterpretationLog();
		const kept = original.append({ author: MODEL, anchor: at(0x1000n), op: EditOp.Rename, value: 'still_pending', status: EditStatus.Proposed });
		const decided = original.append({ author: MODEL, anchor: at(0x2000n), op: EditOp.Comment, value: 'stage two', status: EditStatus.Proposed });
		original.append(original.resolutionOf(decided.seq, EditStatus.Accepted, ANALYST));

		const replayed = InterpretationLog.from(original.log);

		assert.deepStrictEqual({
			pending: replayed.pendingProposals().map(edit => edit.seq),
			decided: replayed.isResolved(decided.seq),
			comment: replayed.at(at(0x2000n)),
			name: replayed.nameAt(at(0x1000n)),
			keptStatus: replayed.editAt(kept.seq)?.status,
		}, {
			pending: [1],
			decided: true,
			comment: { comment: 'stage two' },
			name: undefined,
			keptStatus: EditStatus.Proposed,
		});
	});
});
