/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IListingRowWire, IStringWire } from '../../../../platform/delver/common/protocol.generated.js';

/**
 * How many rows the table holds at once.
 *
 * A full-file virtual list is not an option: `ListView.splice` allocates a
 * per-row bookkeeping object, and a large module decodes to millions of
 * instructions. The buffer slides instead, which is the same approach the
 * debug disassembly view takes.
 */
export const BUFFER_ROWS = 20_000;

/** Rows per fetch. The analysis server caps a window at 4096. */
export const PAGE_ROWS = 512;

/**
 * How close the viewport gets to a buffer edge before the buffer recenters.
 *
 * Recentring replaces the whole buffer, so it must not happen on ordinary
 * scrolling — only when the edge is actually in reach.
 */
const EDGE_TRIGGER_ROWS = 2_000;

/**
 * One listing row. `data` is absent while its page is still in flight, which is
 * what lets the table render immediately instead of waiting on the network.
 */
export interface IListingRow {
	readonly row: number;
	readonly data?: IListingRowWire;
	readonly static?: IListingStaticRow;
}

/** Non-instruction content that participates in the same virtual listing. */
export type IListingStaticRow =
	| { readonly kind: 'metadata'; readonly address: string; readonly lines: readonly string[] }
	| { readonly kind: 'string'; readonly value: IStringWire };

/** A run of buffer-relative row indices. */
export interface IRowRange {
	readonly start: number;
	readonly count: number;
}

/** What the model needs from the analysis session. */
export interface IListingSource {
	listingWindow(startRow: number, count: number): Promise<readonly IListingRowWire[]>;
}

/**
 * A sliding, lazily-filled view over an image's listing rows.
 *
 * Owns two independent notions of "loaded": the **buffer** is the range of rows
 * the table holds (placeholders included), and **pages** are the parts of it
 * that have real data. Scrolling moves the first; fetching fills the second.
 */
export class DelverListingModel extends Disposable {

	private readonly _onDidChangeRows = this._register(new Emitter<IRowRange>());
	/**
	 * Fires when rows gained data, carrying the buffer-relative range affected.
	 *
	 * The range matters: a list widget copies elements when they are spliced in,
	 * so replacing the array contents here is invisible to it. The view has to
	 * splice the changed range back, and splicing the whole buffer on every page
	 * would be twenty thousand elements per fetch.
	 */
	readonly onDidChangeRows: Event<IRowRange> = this._onDidChangeRows.event;

	private readonly _onDidMoveBuffer = this._register(new Emitter<number>());
	/**
	 * Fires when the buffer moved, carrying the signed row delta.
	 *
	 * The view needs the delta to correct its scroll position: every row that
	 * left the front of the buffer shifts the content up by one row height, and
	 * without compensating the view jumps.
	 */
	readonly onDidMoveBuffer: Event<number> = this._onDidMoveBuffer.event;

	private _rows: IListingRow[] = [];
	private _bufferStart = 0;
	private readonly prefixCount: number;
	private readonly instructionRows: number;
	private readonly staticRows: readonly IListingStaticRow[];
	private readonly loaded = new Set<number>();
	private readonly inFlight = new Map<number, Promise<void>>();
	private disposed = false;
	private preserveAnchoredStart = false;

	constructor(
		private readonly source: IListingSource,
		instructionRows: number,
		prefixRows: readonly IListingStaticRow[] = [],
		suffixRows: readonly IListingStaticRow[] = [],
	) {
		super();
		this._register({ dispose: () => { this.disposed = true; } });
		this.prefixCount = prefixRows.length;
		this.instructionRows = instructionRows;
		this.staticRows = [...prefixRows, ...suffixRows];
		this.totalRows = instructionRows + this.staticRows.length;
		this._bufferStart = 0;
		this._rows = this.rowsForRange(0, Math.min(BUFFER_ROWS, this.totalRows));
	}

	readonly totalRows: number;

	/** Rows currently held, starting at {@link bufferStart}. */
	get rows(): readonly IListingRow[] {
		return this._rows;
	}

	/** Absolute ordinal of the first buffered row. */
	get bufferStart(): number {
		return this._bufferStart;
	}

	/** Absolute ordinal one past the last buffered row. */
	get bufferEnd(): number {
		return this._bufferStart + this._rows.length;
	}

	/**
	 * Reports which absolute rows are on screen, so the model can fetch their
	 * pages and slide the buffer when an edge comes into reach.
	 */
	setVisibleRange(firstRow: number, lastRow: number): void {
		if (this.disposed || this.totalRows === 0) {
			return;
		}
		this.recenterIfNeeded(firstRow, lastRow);
		this.fetchPagesFor(firstRow, lastRow);
	}

	/**
	 * Moves the buffer so `row` is its first row, discarding what was there.
	 *
	 * Used by navigation, where the destination can be anywhere in the image.
	 * Keeping the destination at index zero also makes the jump visible in the
	 * same synchronous splice that installs a far-away buffer.
	 */
	anchorAt(row: number): void {
		if (this.disposed || this.totalRows === 0) {
			return;
		}
		const start = Math.min(Math.max(0, row), this.totalRows - 1);
		if (start === this._bufferStart) {
			return;
		}
		this.preserveAnchoredStart = true;
		this.moveBufferTo(start);
	}

	/** Buffer index for an absolute row, or -1 when it is not buffered. */
	indexOf(row: number): number {
		const index = row - this._bufferStart;
		return index >= 0 && index < this._rows.length ? index : -1;
	}

	/** Converts a provider instruction ordinal into this composite listing. */
	instructionRow(row: number): number {
		return this.prefixCount + row;
	}

	private recenterIfNeeded(firstRow: number, lastRow: number): void {
		const nearTop = !this.preserveAnchoredStart
			&& firstRow - this._bufferStart < EDGE_TRIGGER_ROWS
			&& this._bufferStart > 0;
		const nearBottom =
			this.bufferEnd - lastRow < EDGE_TRIGGER_ROWS && this.bufferEnd < this.totalRows;
		if (!nearTop && !nearBottom) {
			return;
		}

		const center = Math.floor((firstRow + lastRow) / 2);
		const start = this.clampStart(center - Math.floor(BUFFER_ROWS / 2));
		if (start !== this._bufferStart) {
			this.preserveAnchoredStart = false;
			this.moveBufferTo(start);
		}
	}

	private moveBufferTo(start: number): void {
		const delta = start - this._bufferStart;
		const length = Math.min(BUFFER_ROWS, this.totalRows - start);

		// Rows that survive the move keep their fetched data; re-requesting a
		// page the model already has would make every recentre flash.
		const next: IListingRow[] = new Array(length);
		for (let i = 0; i < length; i++) {
			const row = start + i;
			const existing = this.indexOf(row);
			next[i] = existing === -1 ? this.rowAt(row) : this._rows[existing];
		}

		this._bufferStart = start;
		this._rows = next;
		this.forgetPagesOutsideBuffer();
		this._onDidMoveBuffer.fire(delta);
	}

	private clampStart(start: number): number {
		const maxStart = Math.max(0, this.totalRows - BUFFER_ROWS);
		return Math.min(Math.max(0, start), maxStart);
	}

	private fetchPagesFor(firstRow: number, lastRow: number): void {
		const firstInstruction = Math.max(0, firstRow - this.prefixCount);
		const lastInstruction = Math.min(this.instructionRows - 1, lastRow - this.prefixCount);
		if (firstInstruction > lastInstruction) {
			return;
		}
		const firstPage = Math.floor(firstInstruction / PAGE_ROWS);
		const lastPage = Math.floor(lastInstruction / PAGE_ROWS);
		for (let page = firstPage; page <= lastPage; page++) {
			this.fetchPage(page);
		}
	}

	private fetchPage(page: number): void {
		if (this.loaded.has(page) || this.inFlight.has(page)) {
			return;
		}
		const startRow = page * PAGE_ROWS;
		if (startRow >= this.instructionRows) {
			return;
		}
		const count = Math.min(PAGE_ROWS, this.instructionRows - startRow);

		const request = this.source
			.listingWindow(startRow, count)
			.then(rows => {
				this.inFlight.delete(page);
				if (this.disposed) {
					return;
				}
				const changed = this.applyRows(rows);
				if (changed) {
					this.loaded.add(page);
					this._onDidChangeRows.fire(changed);
				} else {
					// The buffer can move while a request is in flight. A response
					// that no longer intersects it did not load this page into the
					// model and must not suppress a fetch when navigation returns.
					this.loaded.delete(page);
				}
			}, (error: unknown) => {
				// A failed page stays unloaded so it can be retried when it
				// scrolls back into view, rather than being cached as empty.
				this.inFlight.delete(page);
				// Reported rather than swallowed: the visible result of a failed
				// fetch is a row that stays blank forever, which is impossible to
				// tell apart from a row that is still loading.
				onUnexpectedError(error);
			});

		this.inFlight.set(page, request);
	}

	/**
	 * Fills in fetched rows, returning the buffer range they covered.
	 *
	 * A page can straddle the buffer edge, so only the part that landed inside
	 * it counts as changed.
	 */
	private applyRows(rows: readonly IListingRowWire[]): IRowRange | undefined {
		let first = -1;
		let last = -1;
		for (const data of rows) {
			const listingRow = this.instructionRow(data.row);
			const index = this.indexOf(listingRow);
			if (index === -1) {
				continue;
			}
			this._rows[index] = { row: listingRow, data };
			if (first === -1) {
				first = index;
			}
			last = index;
		}
		return first === -1 ? undefined : { start: first, count: last - first + 1 };
	}

	/**
	 * Drops the record of pages that no longer overlap the buffer.
	 *
	 * Without this the loaded set grows for the lifetime of the editor and, more
	 * importantly, a page scrolled away and back would be considered present
	 * while its rows had been replaced by placeholders.
	 */
	private forgetPagesOutsideBuffer(): void {
		const firstInstruction = Math.max(0, this._bufferStart - this.prefixCount);
		const lastInstruction = Math.min(this.instructionRows - 1, this.bufferEnd - 1 - this.prefixCount);
		if (firstInstruction > lastInstruction) {
			this.loaded.clear();
			return;
		}
		const firstPage = Math.floor(firstInstruction / PAGE_ROWS);
		const lastPage = Math.floor(lastInstruction / PAGE_ROWS);
		for (const page of [...this.loaded]) {
			if (page < firstPage || page > lastPage) {
				this.loaded.delete(page);
			}
		}
	}

	private rowsForRange(start: number, count: number): IListingRow[] {
		const rows = new Array<IListingRow>(Math.max(0, count));
		for (let index = 0; index < rows.length; index++) {
			rows[index] = this.rowAt(start + index);
		}
		return rows;
	}

	private rowAt(row: number): IListingRow {
		if (row < this.prefixCount) {
			return { row, static: this.staticRows[row] };
		}
		const suffixIndex = row - this.prefixCount - this.instructionRows;
		if (suffixIndex >= 0) {
			return { row, static: this.staticRows[this.prefixCount + suffixIndex] };
		}
		return { row };
	}
}
