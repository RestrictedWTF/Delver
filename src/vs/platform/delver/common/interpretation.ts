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
 * Where an edit attaches, when it attaches to a place in the target.
 *
 * The data model also defines `symbol`, `alloc`, and `absolute` for cases that
 * arrive with live targets in P4.
 */
export interface IImageAnchor {
	readonly kind: 'image';
	/** SHA-256 of the image's file bytes, lowercase hex. */
	readonly contentHash: string;
	readonly rva: bigint;
}

/**
 * A named type belonging to one image, which is not at any address.
 *
 * A composite is the first authored thing with no location. `struct Config` is
 * not *at* an RVA — several addresses may hold one, and none of them owns the
 * layout — so anchoring the definition to a use site would make two uses of one
 * struct either duplicate it or contradict each other, and make clearing it
 * ambiguous ([ADR 0014](../../../../../Docs/history/adr/0014-type-anchors-for-authored-composites.md)).
 *
 * Still scoped to `contentHash` and still relocation-proof, which is what
 * invariant 4 is protecting; what widens is only the claim that an anchor names
 * a place.
 */
export interface ITypeAnchor {
	readonly kind: 'type';
	/** SHA-256 of the image's file bytes, lowercase hex. */
	readonly contentHash: string;
	/** Type name, unique per image. `[A-Za-z_][A-Za-z0-9_]*`. */
	readonly name: string;
}

export type Anchor = IImageAnchor | ITypeAnchor;

/** Narrows to an anchor that names a place, which most surfaces only handle. */
export function isImageAnchor(anchor: Anchor): anchor is IImageAnchor {
	return anchor.kind === 'image';
}

/**
 * Narrows to an anchor that names a type rather than a location.
 *
 * Nothing calls this today — every existing type-kind site is a two-way branch
 * that produces a value for both kinds, and the sites that *guard* a `.rva`
 * read reject with `!isImageAnchor` instead. It is kept because being unused is
 * the point: [ADR 0014](../../../../../Docs/history/adr/0014-type-anchors-for-authored-composites.md)
 * records that the pair exists "so every *new* consumer has to make the same
 * choice deliberately, and the compiler is what asks". Deleting the half nobody
 * has needed yet leaves the next consumer with only the rejecting guard, which
 * is how a type anchor ends up silently skipped rather than handled.
 */
export function isTypeAnchor(anchor: Anchor): anchor is ITypeAnchor {
	return anchor.kind === 'type';
}

export const enum EditOp {
	Rename = 'rename',
	Comment = 'comment',
	/** Replaces the complete tag set with a canonical array. */
	Tags = 'tags',
	/** Declares the authored data type at an image address. */
	DataType = 'dataType',
	/** Declares the authored function prototype at a detected function entry. */
	FunctionPrototype = 'functionPrototype',
	/**
	 * Declares the layout of one named composite type.
	 *
	 * Carries canonical JSON rather than a C declaration because Ghidra's parser
	 * resolves type *references* and cannot define a layout; the worker builds
	 * the structure field by field, and explicit offsets are what keep a real
	 * binary's padding from being re-packed into something tidier and wrong.
	 */
	CompositeType = 'compositeType',
	/**
	 * Corrects the function seed set at one image address.
	 *
	 * An analyst can see that detection is wrong — a linear-sweep guess where no
	 * function exists, or a real function nothing referenced — and this is how
	 * they say so. It is authored, not a fact: the correction records the
	 * *decision*, and the analysis server re-derives instructions, blocks and
	 * xrefs from the bytes plus the corrected seeds. Nothing is ever written
	 * into the fact store, which is what keeps the two stores separate.
	 *
	 * Carries canonical JSON — `{"kind":"define","endRva":"0x..."}` or
	 * `{"kind":"undefine"}` — because a correction set is compared, and two
	 * spellings of one correction must not read as two.
	 */
	FunctionBounds = 'functionBounds',
}

export type EditValue = string | readonly string[];

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
	readonly value: EditValue;
	readonly status: EditStatus;
	/** Earlier accepted edits whose effects this append compensates. */
	readonly compensates?: readonly number[];
	/**
	 * Earlier proposals this append decides.
	 *
	 * Distinct from `compensates`: a compensation undoes an effect the picture
	 * already had, while a resolution decides a proposal that never entered it.
	 * Keeping them apart is what lets a review surface show "declined" and
	 * "reverted" as the different things they are.
	 */
	readonly resolves?: readonly number[];
}

/**
 * A complete edit record whose sequence has not been allocated yet.
 *
 * The sequence is not the log's to mint when the log is a replay of a durable
 * store: two windows replaying the same stored edits both reach the same next
 * number, and one of the two writes is then lost. The store allocates against
 * what it actually holds, and {@link InterpretationLog.adopt} files the result.
 */
export type IPendingEdit = Omit<IEdit, 'seq'>;

/** What an edit records, minus the bookkeeping the log fills in. */
export interface IEditRequest {
	readonly author: IAuthor;
	readonly anchor: Anchor;
	readonly op: EditOp;
	readonly value: EditValue;
	readonly status?: EditStatus;
	readonly compensates?: readonly number[];
	readonly resolves?: readonly number[];
}

/** The outcome a human can record against a pending proposal. */
export type ProposalOutcome = EditStatus.Accepted | EditStatus.Rejected;

/** Current interpretation at one anchor, materialized from the log. */
export interface IInterpretationAt {
	readonly name?: string;
	readonly comment?: string;
	readonly tags?: readonly string[];
	readonly dataType?: string;
	readonly functionPrototype?: string;
	/** Canonical JSON layout, present only at a `type` anchor. */
	readonly compositeType?: string;
	/** Canonical JSON function-seed correction, present only at an `image` anchor. */
	readonly functionBounds?: string;
}

/**
 * An authored comment folded onto one line for display.
 *
 * Comments are stored exactly as authored, newlines included — an imported one
 * can be a paragraph. Every surface that shows a comment beside code has one
 * line to do it in, so the fold lives here rather than in each of them, and the
 * stored value is never touched.
 */
export function foldedComment(comment: string | undefined): string | undefined {
	return comment?.replace(/\r\n|\r|\n/g, ' ⏎ ');
}

/**
 * Key for an anchor. Addresses are `bigint`, so they cannot key a Map directly
 * without collapsing distinct images onto one another.
 *
 * The kind is in the key rather than assumed, so a type named after nothing in
 * particular can never share a slot with an address that happens to render the
 * same way.
 */
export function anchorKey(anchor: Anchor): string {
	return anchor.kind === 'type'
		? `${anchor.contentHash}:type:${anchor.name}`
		: `${anchor.contentHash}:rva:${anchor.rva.toString(16)}`;
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
	private readonly bySeq = new Map<number, IEdit>();
	private readonly resolved = new Set<number>();
	private nextSeq = 1;

	/** Every edit, oldest first. This is the record; do not mutate it. */
	get log(): readonly IEdit[] {
		return this.edits;
	}

	/** The lowest sequence this log knows to be free. */
	get nextSequence(): number {
		return this.nextSeq;
	}

	/**
	 * Appends an edit and folds it into the current view.
	 *
	 * Only correct where this log *is* the record — an in-memory picture with no
	 * durable store behind it. Anything that persists must let the store allocate
	 * the sequence: see {@link prepare} and {@link adopt}.
	 *
	 * Accepted by default: a person typing a name has already decided. A model's
	 * edits arrive as `proposed` and only reach the view once accepted.
	 */
	append(request: IEditRequest): IEdit {
		const edit: IEdit = { seq: this.nextSeq, ...this.prepare(request) };
		this.adopt(edit);
		return edit;
	}

	/**
	 * Builds the record for one edit, minus the sequence a store allocates.
	 *
	 * Validation of what the request refers to happens here, before anything is
	 * written, so an invalid resolution never reaches the store.
	 */
	prepare(request: IEditRequest): IPendingEdit {
		for (const seq of request.resolves ?? []) {
			this.assertPending(seq);
		}
		return {
			at: Date.now(),
			author: request.author,
			anchor: request.anchor,
			op: request.op,
			value: request.value,
			status: request.status ?? EditStatus.Accepted,
			compensates: request.compensates,
			resolves: request.resolves,
		};
	}

	/**
	 * Files an edit whose sequence a store allocated.
	 *
	 * Fails closed on a sequence this log already holds: the store is the only
	 * authority on what is unique, and a duplicate arriving here means the two
	 * disagree — which is exactly the condition that loses an authored edit.
	 */
	adopt(edit: IEdit): void {
		if (this.bySeq.has(edit.seq)) {
			throw new Error(`Interpretation sequence ${edit.seq} is already recorded`);
		}
		this.record(edit);
		this.nextSeq = Math.max(this.nextSeq, edit.seq + 1);
	}

	/**
	 * Builds the append that decides one pending proposal.
	 *
	 * Returned rather than appended so the caller can persist it through the
	 * same path as every other edit. Accepting copies the proposal's exact
	 * anchor, op, and value, and is authored by the reviewer: the proposal
	 * remains in the log at `resolves`, so "where did this name come from?" is
	 * still answerable while "who decided it?" names a person.
	 */
	resolutionOf(seq: number, outcome: ProposalOutcome, reviewer: IAuthor): IEditRequest {
		const proposal = this.assertPending(seq);
		return {
			author: reviewer,
			anchor: proposal.anchor,
			op: proposal.op,
			value: proposal.value,
			status: outcome,
			resolves: [seq],
		};
	}

	/** Proposals no later append has decided, oldest first. */
	pendingProposals(): readonly IEdit[] {
		return this.edits.filter(edit => edit.status === EditStatus.Proposed && !this.resolved.has(edit.seq));
	}

	/** Whether a proposal has already been accepted or rejected. */
	isResolved(seq: number): boolean {
		return this.resolved.has(seq);
	}

	/** The edit at `seq`, for a review surface resolving a `resolves` reference. */
	editAt(seq: number): IEdit | undefined {
		return this.bySeq.get(seq);
	}

	/** Current interpretation at `anchor`, if anything has been authored there. */
	at(anchor: Anchor): IInterpretationAt | undefined {
		return this.current.get(anchorKey(anchor));
	}

	/** Authored name at `anchor`, if any. */
	nameAt(anchor: Anchor): string | undefined {
		return this.current.get(anchorKey(anchor))?.name;
	}

	/** Current value of one authored field, in the shape an edit stores it. */
	valueAt(anchor: Anchor, op: EditOp): EditValue {
		const current = this.current.get(anchorKey(anchor));
		switch (op) {
			case EditOp.Rename:
				return current?.name ?? '';
			case EditOp.Comment:
				return current?.comment ?? '';
			case EditOp.Tags:
				return current?.tags ?? [];
			case EditOp.DataType:
				return current?.dataType ?? '';
			case EditOp.FunctionPrototype:
				return current?.functionPrototype ?? '';
			case EditOp.CompositeType:
				return current?.compositeType ?? '';
			case EditOp.FunctionBounds:
				return current?.functionBounds ?? '';
		}
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
			// Replay is deliberately tolerant where `append` is strict: a stored
			// log that references a sequence it does not contain is still the
			// user's work, and refusing to load it loses far more than it protects.
			log.record(edit);
			log.nextSeq = Math.max(log.nextSeq, edit.seq + 1);
		}
		return log;
	}

	/** Files one edit into the log, the index, the resolution set, and the view. */
	private record(edit: IEdit): void {
		this.edits.push(edit);
		this.bySeq.set(edit.seq, edit);
		for (const seq of edit.resolves ?? []) {
			this.resolved.add(seq);
		}
		this.materialize(edit);
	}

	/** Fails closed on an unknown, non-proposed, or already-decided sequence. */
	private assertPending(seq: number): IEdit {
		const proposal = this.bySeq.get(seq);
		if (!proposal) {
			throw new Error(`No interpretation edit at sequence ${seq}`);
		}
		if (proposal.status !== EditStatus.Proposed) {
			throw new Error(`Interpretation edit ${seq} is not a proposal`);
		}
		if (this.resolved.has(seq)) {
			throw new Error(`Proposal ${seq} has already been decided`);
		}
		return proposal;
	}

	private materialize(edit: IEdit): void {
		if (edit.status !== EditStatus.Accepted) {
			return; // visible in the log, not yet part of the picture
		}

		const key = anchorKey(edit.anchor);
		const existing = this.current.get(key) ?? {};
		// An empty value clears the field rather than storing a blank, so that
		// "cleared" and "never set" read the same to every consumer.
		let next: IInterpretationAt;
		switch (edit.op) {
			case EditOp.Rename: {
				const name = textValue(edit);
				next = name === undefined
					? interpretationWithout(existing, 'name')
					: { ...existing, name };
				break;
			}
			case EditOp.Comment: {
				const comment = textValue(edit);
				next = comment === undefined
					? interpretationWithout(existing, 'comment')
					: { ...existing, comment };
				break;
			}
			case EditOp.Tags: {
				const tags = tagValue(edit);
				next = tags === undefined
					? interpretationWithout(existing, 'tags')
					: { ...existing, tags };
				break;
			}
			case EditOp.DataType: {
				const dataType = textValue(edit);
				next = dataType === undefined
					? interpretationWithout(existing, 'dataType')
					: { ...existing, dataType };
				break;
			}
			case EditOp.FunctionPrototype: {
				const functionPrototype = textValue(edit);
				next = functionPrototype === undefined
					? interpretationWithout(existing, 'functionPrototype')
					: { ...existing, functionPrototype };
				break;
			}
			case EditOp.CompositeType: {
				const compositeType = textValue(edit);
				next = compositeType === undefined
					? interpretationWithout(existing, 'compositeType')
					: { ...existing, compositeType };
				break;
			}
			case EditOp.FunctionBounds: {
				const functionBounds = textValue(edit);
				next = functionBounds === undefined
					? interpretationWithout(existing, 'functionBounds')
					: { ...existing, functionBounds };
				break;
			}
		}

		// Emptiness is asked of the object rather than listed field by field, so a
		// field added later cannot be left out of this check and keep a hollow
		// entry alive in the view.
		if (Object.values(next).every(held => held === undefined)) {
			this.current.delete(key);
		} else {
			this.current.set(key, next);
		}
	}
}

function textValue(edit: IEdit): string | undefined {
	if (typeof edit.value !== 'string') {
		throw new Error(`${edit.op} interpretation edit requires a string value`);
	}
	return edit.value === '' ? undefined : edit.value;
}

function tagValue(edit: IEdit): readonly string[] | undefined {
	if (!Array.isArray(edit.value)) {
		throw new Error('tags interpretation edit requires an array value');
	}
	return edit.value.length === 0 ? undefined : [...edit.value];
}

/**
 * The interpretation at an anchor with one authored field cleared.
 *
 * One omitter rather than one helper per field. The per-field version had each
 * helper spell out the other four, so adding a field meant editing every one of
 * them and a miss would silently resurrect a cleared value while clearing a
 * different one. Absent rather than `undefined`, because the view is compared
 * and serialized.
 */
function interpretationWithout(value: IInterpretationAt, field: keyof IInterpretationAt): IInterpretationAt {
	const next: Record<string, unknown> = {};
	for (const [key, held] of Object.entries(value)) {
		if (key !== field && held !== undefined) {
			next[key] = held;
		}
	}
	return next as IInterpretationAt;
}
