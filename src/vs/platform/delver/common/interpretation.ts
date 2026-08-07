/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The interpretation layer: what a person or a model *decided*, as opposed to
 * what the bytes *are*.
 *
 * Kept strictly apart from the facts store (`Docs/architecture/data-model.md`
 * section 3). Facts are recomputable from the input and can be thrown away;
 * interpretation is the user's actual work and cannot. Mixing them means a
 * cache invalidation deletes an analyst's afternoon.
 *
 * Three rules hold here and are load-bearing:
 *
 * 1. **Anchors, not addresses.** An absolute address is not an identity — ASLR,
 *    a re-dump, or another process loading the same module moves it. A name is
 *    keyed to the bytes it describes.
 * 2. **Append-only.** Nothing is mutated or deleted. Undo is unbounded, "show
 *    only what the model changed" is a filter, and reverting a bad batch is a
 *    filter plus a compensating append.
 * 3. **Always attributed.** Every edit records who made it. This is what makes
 *    an AI-assisted analysis auditable rather than merely plausible.
 */

/** Who made an edit. */
export interface IAuthor {
	readonly kind: 'human' | 'rule' | 'model' | 'import';
	/** Analyst name, rule id, model id, or source tool. */
	readonly id: string;
}

/**
 * Where an edit attaches.
 *
 * Only the `image` kind exists so far; the data model defines `symbol`,
 * `alloc`, and `absolute` for cases that arrive with live targets in P4.
 */
export interface IImageAnchor {
	readonly kind: 'image';
	/** SHA-256 of the image's file bytes, lowercase hex. */
	readonly contentHash: string;
	readonly rva: bigint;
}

export type Anchor = IImageAnchor;

export const enum EditOp {
	Rename = 'rename',
	Comment = 'comment',
}

/**
 * Review state. A model's work is visible but provisional until accepted, so
 * that it can be read in context without being mistaken for established fact.
 */
export const enum EditStatus {
	Proposed = 'proposed',
	Accepted = 'accepted',
	Rejected = 'rejected',
}

export interface IEdit {
	readonly seq: number;
	/** Wall clock, milliseconds since the epoch. */
	readonly at: number;
	readonly author: IAuthor;
	readonly anchor: Anchor;
	readonly op: EditOp;
	/** Empty string clears — a deletion is an append like everything else. */
	readonly value: string;
	readonly status: EditStatus;
}

/** What an edit records, minus the bookkeeping the log fills in. */
export interface IEditRequest {
	readonly author: IAuthor;
	readonly anchor: Anchor;
	readonly op: EditOp;
	readonly value: string;
	readonly status?: EditStatus;
}

/** Current interpretation at one anchor, materialized from the log. */
export interface IInterpretationAt {
	readonly name?: string;
	readonly comment?: string;
}

/**
 * Key for an anchor. Addresses are `bigint`, so they cannot key a Map directly
 * without collapsing distinct images onto one another.
 */
function anchorKey(anchor: Anchor): string {
	return `${anchor.contentHash}:${anchor.rva.toString(16)}`;
}

/**
 * An append-only edit log with a materialized current-state view.
 *
 * The log is the truth; the view is a cache. Reads go to the view because the
 * listing asks for interpretation on every visible row, and replaying a log per
 * row would not survive a scroll.
 */
export class InterpretationLog {
	private readonly edits: IEdit[] = [];
	private readonly current = new Map<string, IInterpretationAt>();
	private nextSeq = 1;

	/** Every edit, oldest first. This is the record; do not mutate it. */
	get log(): readonly IEdit[] {
		return this.edits;
	}

	/**
	 * Appends an edit and folds it into the current view.
	 *
	 * Accepted by default: a person typing a name has already decided. A model's
	 * edits arrive as `proposed` and only reach the view once accepted.
	 */
	append(request: IEditRequest): IEdit {
		const edit: IEdit = {
			seq: this.nextSeq++,
			at: Date.now(),
			author: request.author,
			anchor: request.anchor,
			op: request.op,
			value: request.value,
			status: request.status ?? EditStatus.Accepted,
		};
		this.edits.push(edit);
		this.materialize(edit);
		return edit;
	}

	/** Current interpretation at `anchor`, if anything has been authored there. */
	at(anchor: Anchor): IInterpretationAt | undefined {
		return this.current.get(anchorKey(anchor));
	}

	/** Authored name at `anchor`, if any. */
	nameAt(anchor: Anchor): string | undefined {
		return this.current.get(anchorKey(anchor))?.name;
	}

	/**
	 * Rebuilds the view from the log.
	 *
	 * Used when loading a stored log, and the reason the view can be discarded
	 * safely: it holds nothing the log does not.
	 */
	static from(edits: readonly IEdit[]): InterpretationLog {
		const log = new InterpretationLog();
		for (const edit of edits) {
			log.edits.push(edit);
			log.nextSeq = Math.max(log.nextSeq, edit.seq + 1);
			log.materialize(edit);
		}
		return log;
	}

	private materialize(edit: IEdit): void {
		if (edit.status !== EditStatus.Accepted) {
			return; // visible in the log, not yet part of the picture
		}

		const key = anchorKey(edit.anchor);
		const existing = this.current.get(key) ?? {};
		// An empty value clears the field rather than storing a blank, so that
		// "cleared" and "never set" read the same to every consumer.
		const value = edit.value === '' ? undefined : edit.value;
		const next: IInterpretationAt = edit.op === EditOp.Rename
			? { ...existing, name: value }
			: { ...existing, comment: value };

		if (next.name === undefined && next.comment === undefined) {
			this.current.delete(key);
		} else {
			this.current.set(key, next);
		}
	}
}
