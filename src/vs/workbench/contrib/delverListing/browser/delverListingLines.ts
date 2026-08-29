/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IListingRow } from './delverListingModel.js';

/**
 * Height of one rendered listing **line**, in pixels.
 *
 * Not the height of a row. A row is one or more lines — a function entry
 * carries its label on a line above the instruction, and the metadata header is
 * a whole block — so `scrollTop / LISTING_LINE_HEIGHT` is a line ordinal and
 * never a row ordinal. Kept in step with `line-height` in
 * `media/delverListing.css`.
 */
export const LISTING_LINE_HEIGHT = 22;

/**
 * The listing's row-height rule: how many lines a row occupies.
 *
 * There is exactly one implementation of this, on the widget, and both the
 * table's virtual delegate and {@link ListingLineMap} are given it — the map
 * has to agree with the renderer or every conversion built on it is off by the
 * number of tall rows above the viewport.
 */
export type ListingRowLines = (row: IListingRow) => number;

/** A run of buffer row indices, both ends inclusive. */
export interface IVisibleRows {
	readonly first: number;
	readonly last: number;
}

/** Keeps the same rendered content at the viewport top after rows above it change height. */
export function anchoredScrollTop(
	scrollTop: number,
	changedRangeEndPixel: number,
	previousLineCount: number,
	nextLineCount: number,
): number {
	if (changedRangeEndPixel > scrollTop) {
		return scrollTop;
	}
	return Math.max(0, scrollTop + (nextLineCount - previousLineCount) * LISTING_LINE_HEIGHT);
}

/**
 * The one place pixels, lines and row indices convert into each other.
 *
 * Holds the line ordinal each buffered row starts at, so a pixel offset can be
 * resolved to the row actually rendered there. Callers must never divide a
 * scroll offset by a row height themselves: with two-line function headers in
 * the buffer the quotient is a line index, and using it as a row index points
 * the analyst at instructions further down the image than the ones on screen.
 *
 * The map mirrors the table's splices rather than rebuilding on every query:
 * {@link reset} for a buffer that was replaced wholesale, {@link refresh} for a
 * range whose rows changed height (a page arriving, a label being authored).
 */
export class ListingLineMap {

	private rows: readonly IListingRow[];

	/**
	 * `starts[i]` is the first line of row `i`; `starts[rows.length]` is the
	 * total line count, which is what makes the suffix shift in
	 * {@link refresh} a single loop.
	 */
	private starts: number[];

	constructor(rows: readonly IListingRow[], private readonly linesInRow: ListingRowLines) {
		this.rows = [];
		this.starts = [0];
		this.reset(rows);
	}

	/** Number of rows described. */
	get rowCount(): number {
		return this.rows.length;
	}

	/** Total lines across every row, which is the table's height in lines. */
	get lineCount(): number {
		return this.starts[this.rows.length];
	}

	/** Rebuilds from scratch, for a buffer that was replaced wholesale. */
	reset(rows: readonly IListingRow[]): void {
		const starts = new Array<number>(rows.length + 1);
		let line = 0;
		for (let index = 0; index < rows.length; index++) {
			starts[index] = line;
			line += this.linesInRow(rows[index]);
		}
		starts[rows.length] = line;
		this.rows = rows;
		this.starts = starts;
	}

	/**
	 * Recomputes `count` rows starting at `start` and shifts what follows.
	 *
	 * Rows change height in place — a placeholder becomes a two-line function
	 * entry when its page lands, a label appears when one is authored — and the
	 * table splices only that range. Rebuilding the whole buffer for a 512-row
	 * page would scan twenty thousand rows per fetch.
	 */
	refresh(start: number, count: number): void {
		const first = Math.max(0, start);
		const end = Math.min(this.rows.length, start + Math.max(0, count));
		if (first >= end) {
			return;
		}
		let line = this.starts[first];
		for (let index = first; index < end; index++) {
			this.starts[index] = line;
			line += this.linesInRow(this.rows[index]);
		}
		const delta = line - this.starts[end];
		if (delta === 0) {
			return;
		}
		for (let index = end; index <= this.rows.length; index++) {
			this.starts[index] += delta;
		}
	}

	/** The line ordinal row `index` starts at. */
	lineOfRow(index: number): number {
		const clamped = Math.min(Math.max(0, index), this.rows.length);
		return this.starts[clamped];
	}

	/** The row containing line `line`. */
	rowAtLine(line: number): number {
		const count = this.rows.length;
		if (count === 0) {
			return 0;
		}
		if (line <= 0) {
			return 0;
		}
		if (line >= this.lineCount) {
			return count - 1;
		}
		// Last row whose first line is at or above `line`. Rows are not uniform,
		// so this cannot be a division.
		let low = 0;
		let high = count - 1;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (this.starts[mid] <= line) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		return low;
	}

	/** The pixel offset row `index` starts at. */
	pixelOfRow(index: number): number {
		return this.lineOfRow(index) * LISTING_LINE_HEIGHT;
	}

	/** The row rendered at pixel offset `top`. */
	rowAtPixel(top: number): number {
		return this.rowAtLine(Math.floor(Math.max(0, top) / LISTING_LINE_HEIGHT));
	}

	/** The rows covering `height` pixels from `top`, both ends inclusive. */
	rowsInViewport(top: number, height: number): IVisibleRows {
		const first = this.rowAtPixel(top);
		const last = this.rowAtPixel(top + Math.max(0, height - 1));
		return { first, last: Math.max(first, last) };
	}
}
