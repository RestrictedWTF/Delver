/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	FlowKindWire,
	IListingWindowRowWire,
} from '../../../../../platform/delver/common/protocol.generated.js';
import { anchoredScrollTop, LISTING_LINE_HEIGHT, ListingLineMap } from '../../browser/delverListingLines.js';
import { IListingRow, IListingStaticRow } from '../../browser/delverListingModel.js';

/** Ordinals the fixture treats as function entries, which render two lines tall. */
const FUNCTION_ROWS = new Set([5, 10]);

/** The metadata header, which is a block rather than a single line. */
const METADATA: IListingStaticRow = {
	kind: 'metadata',
	address: '0x140001000',
	lines: ['sample.exe', 'x86-64', 'sha256:…'],
};

function instruction(ordinal: number): IListingWindowRowWire {
	return {
		kind: 'instruction',
		row: ordinal,
		rva: `0x${(0x1000 + ordinal).toString(16).toUpperCase()}`,
		len: 1,
		mnemonic: 'nop',
		operands: '',
		flow: FlowKindWire.Sequential,
	};
}

/**
 * The fixture's row-height rule, standing in for the widget's: a metadata block
 * is as tall as its lines, a function entry carries a label above its
 * instruction, and a row whose page has not landed is a one-line placeholder.
 */
function linesInRow(row: IListingRow): number {
	if (row.static?.kind === 'metadata') {
		return row.static.lines.length;
	}
	if (row.data === undefined) {
		return 1;
	}
	return FUNCTION_ROWS.has(row.row) ? 2 : 1;
}

/** A buffer of `count` rows: a metadata header, then loaded instructions. */
function buffer(count: number): IListingRow[] {
	const rows: IListingRow[] = [{ row: 0, static: METADATA }];
	for (let ordinal = 1; ordinal < count; ordinal++) {
		rows.push({ row: ordinal, data: instruction(ordinal) });
	}
	return rows;
}

/** The same buffer before any page has landed. */
function placeholders(count: number): IListingRow[] {
	const rows: IListingRow[] = [{ row: 0, static: METADATA }];
	for (let ordinal = 1; ordinal < count; ordinal++) {
		rows.push({ row: ordinal });
	}
	return rows;
}

suite('Delver listing line map', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a scroll offset resolves to the row rendered there, not to the line count', () => {
		// 3 metadata lines, then one line per instruction except the two function
		// entries. Dividing the offset by the line height would name rows 7, 8, 9
		// and 15 for these offsets — all of them below what is actually on screen.
		const map = new ListingLineMap(buffer(12), linesInRow);
		const offsets = [0, 3, 7, 8, 9, 15, 100].map(line => line * LISTING_LINE_HEIGHT);
		assert.deepStrictEqual(
			[map.lineCount, ...offsets.map(top => map.rowAtPixel(top))],
			[16, 0, 1, 5, 5, 6, 11, 11],
		);
	});

	test('row → line → row is the identity, tall rows included', () => {
		const rows = buffer(12);
		const map = new ListingLineMap(rows, linesInRow);
		assert.deepStrictEqual(
			rows.map((_, index) => [map.rowAtLine(map.lineOfRow(index)), map.rowAtPixel(map.pixelOfRow(index))]),
			rows.map((_, index) => [index, index]),
		);
	});

	test('a page landing on placeholder rows shifts every row below it', () => {
		const rows = placeholders(12);
		const map = new ListingLineMap(rows, linesInRow);
		const beforeFetch = rows.map((_, index) => map.lineOfRow(index));

		// The model fills its row array in place and reports the range, which is
		// what the widget hands to `refresh`.
		for (let index = 5; index < rows.length; index++) {
			rows[index] = { row: index, data: instruction(index) };
		}
		map.refresh(5, rows.length - 5);

		const rebuilt = new ListingLineMap(rows, linesInRow);
		assert.deepStrictEqual(
			[
				beforeFetch,
				rows.map((_, index) => map.lineOfRow(index)),
				map.lineCount,
			],
			[
				[0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
				rows.map((_, index) => rebuilt.lineOfRow(index)),
				rebuilt.lineCount,
			],
		);
	});

	test('a page landing above the viewport preserves the visible content', () => {
		const rows = placeholders(12);
		const map = new ListingLineMap(rows, linesInRow);
		const scrollTop = map.pixelOfRow(9);
		const changedRangeEndPixel = map.pixelOfRow(8);
		const previousLineCount = map.lineCount;
		for (let index = 5; index < 8; index++) {
			rows[index] = { row: index, data: instruction(index) };
		}
		map.refresh(5, 3);

		assert.strictEqual(
			anchoredScrollTop(scrollTop, changedRangeEndPixel, previousLineCount, map.lineCount),
			scrollTop + LISTING_LINE_HEIGHT,
		);
		assert.strictEqual(
			anchoredScrollTop(scrollTop, scrollTop + 1, previousLineCount, map.lineCount),
			scrollTop,
		);
	});

	test('the viewport covers every row it touches, and a recentred buffer starts over', () => {
		const map = new ListingLineMap(buffer(12), linesInRow);
		// Four lines from the top of the two-line function entry at row 5: that is
		// rows 5, 6 and 7, and the naive quotient would report rows 7 to 10.
		const viewport = map.rowsInViewport(7 * LISTING_LINE_HEIGHT, 4 * LISTING_LINE_HEIGHT);

		map.reset(placeholders(4));
		assert.deepStrictEqual(
			[viewport, map.rowCount, map.lineCount, map.rowAtPixel(5 * LISTING_LINE_HEIGHT)],
			[{ first: 5, last: 7 }, 4, 6, 3],
		);
	});
});
