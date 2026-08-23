/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	FlowKindWire,
	IListingRowWire,
	StringEncodingWire,
} from '../../../../../platform/delver/common/protocol.generated.js';
import {
	BUFFER_ROWS,
	DelverListingModel,
	IListingSource,
	IRowRange,
	PAGE_ROWS,
} from '../../browser/delverListingModel.js';

/** Records every window asked for, so paging behaviour can be asserted. */
class RecordingSource implements IListingSource {
	readonly requests: { startRow: number; count: number }[] = [];
	private readonly pending: (() => void)[] = [];

	constructor(private readonly deferred = false) { }

	async listingWindow(startRow: number, count: number): Promise<readonly IListingRowWire[]> {
		this.requests.push({ startRow, count });
		const rows = Array.from({ length: count }, (_, i) => row(startRow + i));
		if (!this.deferred) {
			return rows;
		}
		return new Promise(resolve => this.pending.push(() => resolve(rows)));
	}

	/** Releases every deferred fetch. */
	flush(): void {
		const waiting = this.pending.splice(0);
		for (const resolve of waiting) {
			resolve();
		}
	}
}

function row(ordinal: number): IListingRowWire {
	return {
		row: ordinal,
		rva: `0x${(0x1000 + ordinal).toString(16).toUpperCase()}`,
		len: 1,
		mnemonic: 'nop',
		operands: '',
		flow: FlowKindWire.Sequential,
	};
}

/** Lets the queued page fetches settle. */
function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

suite('DelverListingModel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('rows start as placeholders so the table never waits on a fetch', () => {
		const model = store.add(new DelverListingModel(new RecordingSource(), 10_000));

		assert.deepStrictEqual(
			{ length: model.rows.length, first: model.rows[0], bufferStart: model.bufferStart },
			{ length: 10_000, first: { row: 0 }, bufferStart: 0 },
		);
	});

	test('a visible range fetches only the pages covering it', async () => {
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, 100_000));

		model.setVisibleRange(0, 10);
		await settle();

		assert.deepStrictEqual(source.requests, [{ startRow: 0, count: PAGE_ROWS }]);
		assert.strictEqual(model.rows[5].data?.mnemonic, 'nop');
	});

	test('metadata and strings are real rows around the instruction listing', async () => {
		const source = new RecordingSource();
		const metadata = { kind: 'metadata' as const, address: '.text:0x1000', lines: ['; first', '; second'] };
		const stringRow = {
			kind: 'string' as const,
			value: { rva: '0x2000', encoding: StringEncodingWire.Ascii, text: 'hello' },
		};
		const model = store.add(new DelverListingModel(source, 3, [metadata], [stringRow]));

		assert.strictEqual(model.totalRows, 5);
		assert.deepStrictEqual(model.rows[0].static, metadata);
		assert.strictEqual(model.instructionRow(0), 1);
		assert.deepStrictEqual(model.rows[4].static, stringRow);

		model.setVisibleRange(0, 4);
		await settle();

		assert.deepStrictEqual(source.requests, [{ startRow: 0, count: 3 }]);
		assert.strictEqual(model.rows[1].data?.row, 0);
	});

	test('a page is fetched once however often it is asked for', async () => {
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, 100_000));

		model.setVisibleRange(0, 10);
		model.setVisibleRange(2, 12);
		await settle();
		model.setVisibleRange(4, 14);
		await settle();

		assert.strictEqual(source.requests.length, 1);
	});

	test('rows stay placeholders while their page is in flight', async () => {
		const source = new RecordingSource(true);
		const model = store.add(new DelverListingModel(source, 100_000));

		model.setVisibleRange(0, 10);
		await settle();
		assert.strictEqual(model.rows[0].data, undefined, 'still pending');

		source.flush();
		await settle();
		assert.ok(model.rows[0].data, 'resolved');
	});

	test('a page that resolves outside the buffer is fetched again when navigation returns', async () => {
		const source = new RecordingSource(true);
		const model = store.add(new DelverListingModel(source, BUFFER_ROWS * 4));

		model.setVisibleRange(0, 10);
		await settle();
		model.anchorAt(BUFFER_ROWS * 3);
		source.flush();
		await settle();

		model.anchorAt(0);
		model.setVisibleRange(0, 10);
		await settle();

		assert.deepStrictEqual(source.requests, [
			{ startRow: 0, count: PAGE_ROWS },
			{ startRow: 0, count: PAGE_ROWS },
		]);
		source.flush();
		await settle();
		assert.ok(model.rows[0].data, 'the returned-to page loaded instead of staying blank');
	});

	test('the buffer is bounded and recentres when the viewport nears its end', async () => {
		const total = BUFFER_ROWS * 4;
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, total));

		assert.strictEqual(model.rows.length, BUFFER_ROWS, 'buffer is capped');

		const deltas: number[] = [];
		store.add(model.onDidMoveBuffer(delta => deltas.push(delta)));

		const target = BUFFER_ROWS - 100;
		model.setVisibleRange(target, target + 40);
		await settle();

		assert.ok(deltas.length === 1 && deltas[0] > 0, 'buffer moved forward exactly once');
		assert.ok(model.indexOf(target) !== -1, 'the visible rows are still buffered');
		assert.strictEqual(model.rows.length, BUFFER_ROWS, 'and it is still capped');
	});

	test('recentring keeps rows that survive the move', async () => {
		const total = BUFFER_ROWS * 4;
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, total));

		const target = BUFFER_ROWS - 100;
		model.setVisibleRange(target, target + 40);
		await settle();

		// Fetched before the move and still inside the buffer after it: a
		// refetch here would make every recentre flash.
		const before = source.requests.length;
		model.setVisibleRange(target, target + 40);
		await settle();

		assert.strictEqual(source.requests.length, before, 'no page was refetched');
		assert.ok(model.rows[model.indexOf(target)].data, 'surviving rows kept their data');
	});

	test('anchoring jumps the buffer anywhere in the image', () => {
		const total = BUFFER_ROWS * 10;
		const model = store.add(new DelverListingModel(new RecordingSource(), total));

		model.anchorAt(total - 1);

		assert.ok(model.indexOf(total - 1) !== -1, 'the destination is buffered');
		assert.strictEqual(model.bufferStart, total - 1, 'the destination is installed as the first visible row');
		assert.strictEqual(model.bufferEnd, total, 'the buffer stops at the last row');
	});

	test('an image smaller than the buffer is held whole', () => {
		const model = store.add(new DelverListingModel(new RecordingSource(), 3));

		model.setVisibleRange(0, 2);

		assert.deepStrictEqual(
			{ length: model.rows.length, start: model.bufferStart, end: model.bufferEnd },
			{ length: 3, start: 0, end: 3 },
		);
	});

	test('an empty image asks for nothing', async () => {
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, 0));

		model.setVisibleRange(0, 10);
		await settle();

		assert.deepStrictEqual({ rows: model.rows.length, requests: source.requests }, { rows: 0, requests: [] });
	});

	test('a failed page is reported and retried rather than cached as empty', async () => {
		let attempts = 0;
		const source: IListingSource = {
			listingWindow: async (startRow, count) => {
				attempts++;
				if (attempts === 1) {
					throw new Error('provider went away');
				}
				return Array.from({ length: count }, (_, i) => row(startRow + i));
			},
		};

		const reported: unknown[] = [];
		const previous = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(error => reported.push(error));
		try {
			const model = store.add(new DelverListingModel(source, 10_000));

			model.setVisibleRange(0, 10);
			await settle();
			assert.strictEqual(model.rows[0].data, undefined, 'the failure left a placeholder');
			assert.strictEqual(reported.length, 1, 'a blank row that never fills must not be silent');

			model.setVisibleRange(0, 10);
			await settle();
			assert.ok(model.rows[0].data, 'and the page was retried');
		} finally {
			setUnexpectedErrorHandler(previous);
		}
	});

	test('a loaded page reports the range it filled', async () => {
		const source = new RecordingSource();
		const model = store.add(new DelverListingModel(source, 100_000));

		const ranges: IRowRange[] = [];
		store.add(model.onDidChangeRows(range => ranges.push(range)));

		model.setVisibleRange(0, 10);
		await settle();

		// The view splices exactly this range back into the table: a list widget
		// copies its elements, so a range that is wrong here leaves rows blank on
		// screen while the model believes they are loaded.
		assert.deepStrictEqual(ranges, [{ start: 0, count: PAGE_ROWS }]);
	});
});
