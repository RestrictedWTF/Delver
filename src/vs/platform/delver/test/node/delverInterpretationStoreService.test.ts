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
import { NullLogService } from '../../../log/common/log.js';
import { IInterpretationEditRequestWire, IInterpretationEditWire } from '../../common/delverInterpretationStoreService.js';
import { EditOp, EditStatus } from '../../common/interpretation.js';
import { DelverInterpretationStoreService } from '../../node/delverInterpretationStoreService.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Captures what the store reports rather than discarding it. */
class RecordingLogService extends NullLogService {
	readonly warnings: string[] = [];

	override warn(message: string): void {
		this.warnings.push(message);
	}
}

function request(contentHash: string, label: number, rva = '0x1000000000000001'): IInterpretationEditRequestWire {
	return {
		at: 1_700_000_000_000 + label,
		author: { kind: 'human', id: 'analyst' },
		anchor: { kind: 'image', contentHash, rva },
		op: EditOp.Rename,
		value: `name_${label}`,
		status: EditStatus.Accepted,
	};
}

function stored(contentHash: string, label: number, seq: number, rva?: string): IInterpretationEditWire {
	return { seq, ...request(contentHash, label, rva) };
}

suite('DelverInterpretationStoreService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let userDataPath: string;
	let logService: RecordingLogService;
	let service: DelverInterpretationStoreService;

	setup(async () => {
		userDataPath = await promises.mkdtemp(join(tmpdir(), 'delver-interpretation-test-'));
		logService = new RecordingLogService();
		service = new DelverInterpretationStoreService({ userDataPath } as unknown as INativeEnvironmentService, logService);
	});

	teardown(async () => {
		await promises.rm(userDataPath, { recursive: true, force: true });
	});

	test('appends one wire-safe JSON line per edit and replays it', async () => {
		await Promise.all([
			service.append(HASH_A, request(HASH_A, 1)),
			service.append(HASH_A, request(HASH_A, 2, '0xffffffffffffffff')),
		]);

		const path = join(userDataPath, 'delver', 'interpretation', `${HASH_A}.delverdb`);
		const contents = await promises.readFile(path, 'utf8');
		assert.deepStrictEqual(
			{ edits: await service.load(HASH_A), lines: contents.trimEnd().split('\n').length },
			{ edits: [stored(HASH_A, 1, 1), stored(HASH_A, 2, 2, '0xffffffffffffffff')], lines: 2 },
		);
	});

	test('persists data types and function prototypes as ordinary append-only edits', async () => {
		const dataType = { ...request(HASH_A, 1), op: EditOp.DataType, value: 'IMAGE_DOS_HEADER' };
		const prototype = { ...request(HASH_A, 2, '0x1400'), op: EditOp.FunctionPrototype, value: 'int parse_header(const void *data)' };

		const first = await service.append(HASH_A, dataType);
		const second = await service.append(HASH_A, prototype);

		assert.deepStrictEqual(await service.load(HASH_A), [
			{ seq: 1, ...dataType },
			{ seq: 2, ...prototype },
		]);
		assert.deepStrictEqual([first.op, second.op], [EditOp.DataType, EditOp.FunctionPrototype]);
	});

	test('allocates sequences against the store rather than against a caller copy of the log', async () => {
		// Two windows replaying the same one-edit log both believe the next free
		// sequence is 2. The store is the only thing that sees both writes, so it
		// is the only thing that can keep them apart — dropping either one loses
		// work nothing in the system can recompute.
		const first = await service.append(HASH_A, request(HASH_A, 1));
		const [second, third] = await Promise.all([
			service.append(HASH_A, request(HASH_A, 2), 2),
			service.append(HASH_A, request(HASH_A, 3), 2),
		]);
		// A caller holding a log the store has never seen — a project opened from
		// a `.delverdb` — passes a floor, and the allocation clears it.
		const fourth = await service.append(HASH_A, request(HASH_A, 4), 50);

		assert.deepStrictEqual({
			seqs: [first.seq, second.seq, third.seq, fourth.seq],
			replayed: (await service.load(HASH_A)).map(edit => edit.seq),
			refusedFloor: await service.append(HASH_A, request(HASH_A, 5), 0).then(() => 'accepted', error => (error as Error).message),
		}, {
			seqs: [1, 2, 3, 50],
			replayed: [1, 2, 3, 50],
			refusedFloor: 'Interpretation sequence floor must be a positive integer',
		});
	});

	test('a truncated final append costs only that edit and the log remains appendable', async () => {
		await service.append(HASH_A, request(HASH_A, 1));
		const path = join(userDataPath, 'delver', 'interpretation', `${HASH_A}.delverdb`);
		await promises.appendFile(path, '{"seq":2', 'utf8');

		assert.deepStrictEqual(await service.load(HASH_A), [stored(HASH_A, 1, 1)]);
		await service.append(HASH_A, request(HASH_A, 3));
		assert.deepStrictEqual(await service.load(HASH_A), [stored(HASH_A, 1, 1), stored(HASH_A, 3, 2)]);
	});

	test('export and import preserve attribution and reject different bytes', async () => {
		await service.append(HASH_A, request(HASH_A, 1));
		const exported = join(userDataPath, 'shared.delverlog');
		assert.strictEqual(await service.exportLog(HASH_A, exported), 1);

		const importedUserData = join(userDataPath, 'second-profile');
		const imported = new DelverInterpretationStoreService(
			{ userDataPath: importedUserData } as unknown as INativeEnvironmentService,
			new NullLogService(),
		);
		assert.deepStrictEqual(await imported.importLog(HASH_A, exported), [stored(HASH_A, 1, 1)]);
		assert.deepStrictEqual(await imported.load(HASH_A), [stored(HASH_A, 1, 1)]);
		await assert.rejects(() => imported.importLog(HASH_B, exported), /line 1/);
	});

	test('carries a composite through the log, and refuses an op on the wrong anchor', async () => {
		// A composite is the first authored thing with no address, so the JSONL
		// store had to stop assuming every anchor has one. The pairing check is
		// the part worth testing: a `compositeType` at an RVA would be accepted
		// by a looser validator and then read by nothing, because the snapshot
		// builder only looks at type anchors — silently inert rather than refused.
		const composite: IInterpretationEditRequestWire = {
			at: 1_700_000_000_001,
			author: { kind: 'model', id: 'test-model' },
			anchor: { kind: 'type', contentHash: HASH_A, name: 'Config' },
			op: EditOp.CompositeType,
			value: JSON.stringify({ kind: 'struct', size: 16, fields: [{ offset: 0, name: 'flags', type: 'uint32_t' }] }),
			status: EditStatus.Accepted,
		};
		const saved = await service.append(HASH_A, composite);
		const exported = join(userDataPath, 'composite.delverlog');
		await service.exportLog(HASH_A, exported);

		const reimportPath = join(userDataPath, 'reimported');
		const reimported = new DelverInterpretationStoreService(
			{ userDataPath: reimportPath } as unknown as INativeEnvironmentService,
			new NullLogService(),
		);

		const refuse = async (edit: IInterpretationEditRequestWire): Promise<string> => {
			try {
				await service.append(HASH_A, edit);
				return 'accepted';
			} catch (error) {
				return (error as Error).message;
			}
		};

		assert.deepStrictEqual({
			replayed: (await service.load(HASH_A)).map(edit => edit.anchor),
			imported: (await reimported.importLog(HASH_A, exported)).map(edit => edit.op),
			seq: saved.seq,
			compositeAtAnAddress: await refuse({ ...composite, anchor: { kind: 'image', contentHash: HASH_A, rva: '0x2000' } }),
			renameOnAType: await refuse({ ...composite, op: EditOp.Rename, value: 'Renamed' }),
			unnamedType: await refuse({ ...composite, anchor: { kind: 'type', contentHash: HASH_A, name: '0bad' } }),
		}, {
			replayed: [{ kind: 'type', contentHash: HASH_A, name: 'Config' }],
			imported: [EditOp.CompositeType],
			seq: 1,
			compositeAtAnAddress: 'Invalid interpretation edit at edit',
			renameOnAType: 'Invalid interpretation edit at edit',
			unnamedType: 'Invalid interpretation edit at edit',
		});
	});

	test('carries a function correction at an address, and refuses one at a type', async () => {
		// The op list here is explicit so a build that has not been taught about
		// a new op refuses the record rather than misreading it. That fails
		// closed, which also means a new op is inert until it is added — this is
		// what proves `functionBounds` was.
		const correction: IInterpretationEditRequestWire = {
			at: 1_700_000_000_002,
			author: { kind: 'model', id: 'test-model' },
			anchor: { kind: 'image', contentHash: HASH_A, rva: '0x1400' },
			op: EditOp.FunctionBounds,
			value: '{"kind":"define","endRva":"0x1480"}',
			status: EditStatus.Proposed,
		};
		await service.append(HASH_A, correction);

		const refuse = async (edit: IInterpretationEditRequestWire): Promise<string> => {
			try {
				await service.append(HASH_A, edit);
				return 'accepted';
			} catch (error) {
				return (error as Error).message;
			}
		};

		assert.deepStrictEqual({
			replayed: (await service.load(HASH_A)).map(edit => ({ op: edit.op, value: edit.value, status: edit.status })),
			atAType: await refuse({ ...correction, anchor: { kind: 'type', contentHash: HASH_A, name: 'Config' } }),
		}, {
			replayed: [{ op: EditOp.FunctionBounds, value: '{"kind":"define","endRva":"0x1480"}', status: EditStatus.Proposed }],
			atAType: 'Invalid interpretation edit at edit',
		});
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
		await service.append(HASH_A, request(HASH_A, 7), 7);
		const source = join(userDataPath, 'compensated.delverlog');
		const original = [
			{ ...stored(HASH_A, 1, 1), op: EditOp.Tags, value: ['crypto'] },
			{ ...stored(HASH_A, 2, 2), op: EditOp.Tags, value: [], compensates: [1] },
		];
		await promises.writeFile(source, original.map(value => `${JSON.stringify(value)}\n`).join(''), 'utf8');

		const imported = await service.importLog(HASH_A, source);

		assert.deepStrictEqual(
			imported.map(value => ({ seq: value.seq, compensates: value.compensates })),
			[{ seq: 8, compensates: undefined }, { seq: 9, compensates: [8] }],
		);
	});

	test('an imported reference the log does not contain is dropped and reported', async () => {
		// Left alone, `99` and `42` would land on whichever local edit happens to
		// hold that number and claim to undo or decide it. There is nothing to
		// point at, so the references go and the drop is reported.
		await service.append(HASH_A, request(HASH_A, 1), 3);
		const source = join(userDataPath, 'dangling.delverlog');
		const original = [
			{ ...stored(HASH_A, 1, 1), op: EditOp.Tags, value: ['crypto'] },
			{ ...stored(HASH_A, 2, 2), op: EditOp.Tags, value: [], compensates: [1, 99] },
			{ ...stored(HASH_A, 5, 5), resolves: [42] },
		];
		await promises.writeFile(source, original.map(value => `${JSON.stringify(value)}\n`).join(''), 'utf8');

		const imported = await service.importLog(HASH_A, source);
		const references = (edits: readonly IInterpretationEditWire[]) =>
			edits.map(value => ({ seq: value.seq, compensates: value.compensates, resolves: value.resolves }));

		assert.deepStrictEqual({
			imported: references(imported),
			replayed: references(await service.load(HASH_A)),
			reported: logService.warnings.filter(warning => warning.includes('dropped 2 cross-reference(s)')).length,
		}, {
			imported: [
				{ seq: 4, compensates: undefined, resolves: undefined },
				{ seq: 5, compensates: [4], resolves: undefined },
				{ seq: 6, compensates: undefined, resolves: undefined },
			],
			replayed: [
				{ seq: 3, compensates: undefined, resolves: undefined },
				{ seq: 4, compensates: undefined, resolves: undefined },
				{ seq: 5, compensates: [4], resolves: undefined },
				{ seq: 6, compensates: undefined, resolves: undefined },
			],
			reported: 1,
		});
	});

	test('resolution references survive a merged import and a malformed one is refused', async () => {
		await service.append(HASH_A, request(HASH_A, 7), 7);
		const source = join(userDataPath, 'reviewed.delverlog');
		const original = [
			{ ...stored(HASH_A, 1, 1), value: 'proposed_name', status: EditStatus.Proposed, author: { kind: 'model', id: 'opus-5' } },
			{ ...stored(HASH_A, 2, 2), value: 'proposed_name', resolves: [1] },
		];
		await promises.writeFile(source, original.map(value => `${JSON.stringify(value)}\n`).join(''), 'utf8');
		const malformed = join(userDataPath, 'malformed.delverlog');
		await promises.writeFile(malformed, `${JSON.stringify({ ...stored(HASH_A, 1, 1), resolves: [0] })}\n`, 'utf8');

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
