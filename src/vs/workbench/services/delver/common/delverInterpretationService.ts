/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	Anchor,
	EditOp,
	EditStatus,
	EditValue,
	IAuthor,
	IEdit,
	IInterpretationAt,
	InterpretationLog,
	ProposalOutcome,
} from '../../../../platform/delver/common/interpretation.js';
import {
	editFromWire,
	editToWire,
	IInterpretationEditWire,
	IDelverInterpretationStoreService,
} from '../../../../platform/delver/common/delverInterpretationStoreService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IDelverInterpretationService = createDecorator<IDelverInterpretationService>('delverInterpretationService');

export interface IInterpretationChangeEvent {
	readonly edit: IEdit;
}

/**
 * The workbench's view of what has been authored about the open images.
 *
 * One log per content hash, because interpretation belongs to the *bytes*, not
 * to the session that happened to open them. Re-opening the same binary must
 * bring its names back, and opening a different one must not.
 */
export interface IDelverInterpretationService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<IInterpretationChangeEvent>;

	/** Loads and replays the stored log before an image is published. */
	load(contentHash: string): Promise<void>;

	/** Restores the portable project's authored log without requiring its original sample. */
	loadFromProject(contentHash: string, edits: readonly IInterpretationEditWire[]): void;

	/** Authored name at `anchor`, if any. */
	nameAt(anchor: Anchor): string | undefined;

	/** Everything authored at `anchor`. */
	at(anchor: Anchor): IInterpretationAt | undefined;

	/**
	 * Names for many addresses in one image, for callers rendering a list.
	 *
	 * The listing asks about every visible row on every scroll, so this exists
	 * to keep that a single call rather than one per row.
	 */
	namesFor(contentHash: string, rvas: readonly bigint[]): Map<bigint, string>;

	/** Records an edit. Appends to the log; nothing is overwritten. */
	edit(anchor: Anchor, op: EditOp, value: EditValue, author?: IAuthor): Promise<IEdit>;

	/**
	 * Records a provisional edit. Visible in the log, absent from the picture
	 * until a human decides it — the whole point of the proposed state.
	 */
	propose(anchor: Anchor, op: EditOp, value: EditValue, author: IAuthor): Promise<IEdit>;

	/** Proposals awaiting a decision for one image, oldest first. */
	pendingProposals(contentHash: string): readonly IEdit[];

	/**
	 * Decides pending proposals after validating the complete requested batch.
	 *
	 * An invalid sequence prevents every append. Persistence still consists of
	 * independent append-only records, so an I/O failure may commit a prefix.
	 */
	resolveProposals(contentHash: string, seqs: readonly number[], outcome: ProposalOutcome, reviewer?: IAuthor): Promise<readonly IEdit[]>;

	/** Compensates the most recent uncompensated accepted edit by `author`. */
	undoLast(contentHash: string, author?: IAuthor): Promise<IEdit | undefined>;

	/** Appends compensations that reconstruct state as if `author` had not edited it. */
	revertAuthor(contentHash: string, author: IAuthor, actor?: IAuthor): Promise<number>;

	/** Exports one image's complete append-only log. */
	exportTo(contentHash: string, destinationPath: string): Promise<number>;

	/** Imports and materializes edits authored for this exact image. */
	importFrom(contentHash: string, sourcePath: string): Promise<number>;

	/** The full log for one image, oldest first. */
	logFor(contentHash: string): readonly IEdit[];
}

/**
 * The author used when the workbench itself records an edit.
 *
 * Attribution is not optional — an unattributed edit is indistinguishable from
 * a fact, which is exactly the confusion this layer exists to prevent. A real
 * analyst identity arrives with the project store.
 */
const LOCAL_AUTHOR: IAuthor = { kind: 'human', id: 'local' };

export class DelverInterpretationService extends Disposable implements IDelverInterpretationService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IInterpretationChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly logs = new Map<string, InterpretationLog>();
	private readonly loading = new Map<string, Promise<void>>();
	private readonly edits = new Map<string, Promise<void>>();

	constructor(
		@IDelverInterpretationStoreService private readonly storeService: IDelverInterpretationStoreService,
	) {
		super();
	}

	load(contentHash: string): Promise<void> {
		if (this.logs.has(contentHash)) {
			return Promise.resolve();
		}
		let loading = this.loading.get(contentHash);
		if (!loading) {
			loading = this.storeService.load(contentHash).then(edits => {
				this.logs.set(contentHash, InterpretationLog.from(edits.map(editFromWire)));
			});
			this.loading.set(contentHash, loading);
			void loading.then(
				() => this.loading.delete(contentHash),
				() => this.loading.delete(contentHash),
			);
		}
		return loading;
	}

	loadFromProject(contentHash: string, edits: readonly IInterpretationEditWire[]): void {
		this.logs.set(contentHash, InterpretationLog.from(edits.map(editFromWire)));
	}

	nameAt(anchor: Anchor): string | undefined {
		return this.logs.get(anchor.contentHash)?.nameAt(anchor);
	}

	at(anchor: Anchor): IInterpretationAt | undefined {
		return this.logs.get(anchor.contentHash)?.at(anchor);
	}

	namesFor(contentHash: string, rvas: readonly bigint[]): Map<bigint, string> {
		const names = new Map<bigint, string>();
		const log = this.logs.get(contentHash);
		if (!log) {
			return names;
		}
		for (const rva of rvas) {
			const name = log.nameAt({ kind: 'image', contentHash, rva });
			if (name !== undefined) {
				names.set(rva, name);
			}
		}
		return names;
	}

	edit(anchor: Anchor, op: EditOp, value: EditValue, author: IAuthor = LOCAL_AUTHOR): Promise<IEdit> {
		return this.queueEdit(anchor.contentHash, async () => {
			await this.load(anchor.contentHash);
			return this.appendPersisted(anchor.contentHash, { author, anchor, op, value });
		});
	}

	propose(anchor: Anchor, op: EditOp, value: EditValue, author: IAuthor): Promise<IEdit> {
		return this.queueEdit(anchor.contentHash, async () => {
			await this.load(anchor.contentHash);
			return this.appendPersisted(anchor.contentHash, { author, anchor, op, value, status: EditStatus.Proposed });
		});
	}

	pendingProposals(contentHash: string): readonly IEdit[] {
		return this.logs.get(contentHash)?.pendingProposals() ?? [];
	}

	resolveProposals(contentHash: string, seqs: readonly number[], outcome: ProposalOutcome, reviewer: IAuthor = LOCAL_AUTHOR): Promise<readonly IEdit[]> {
		return this.queueEdit(contentHash, async () => {
			await this.load(contentHash);
			if (new Set(seqs).size !== seqs.length) {
				throw new Error('A review batch cannot decide the same proposal twice');
			}
			const log = this.logs.get(contentHash)!;
			// Build every resolution against the pre-batch log first. Nothing is
			// appended or persisted until all of them are known to be valid.
			const requests = seqs.map(seq => log.resolutionOf(seq, outcome, reviewer));
			const resolutions: IEdit[] = [];
			for (const request of requests) {
				resolutions.push(await this.appendPersisted(contentHash, request));
			}
			return resolutions;
		});
	}

	undoLast(contentHash: string, author: IAuthor = LOCAL_AUTHOR): Promise<IEdit | undefined> {
		return this.queueEdit(contentHash, async () => {
			await this.load(contentHash);
			const log = this.logs.get(contentHash)!;
			const active = activeLogEdits(log.log);
			const compensated = compensatedSequences(log.log);
			const target = [...log.log].reverse().find(edit =>
				edit.status === EditStatus.Accepted
				&& edit.compensates === undefined
				&& !compensated.has(edit.seq)
				&& sameAuthor(edit.author, author)
			);
			if (!target) {
				return undefined;
			}

			const desired = InterpretationLog.from(active.filter(edit => edit !== target));
			return this.appendPersisted(contentHash, {
				author,
				anchor: target.anchor,
				op: target.op,
				value: desired.valueAt(target.anchor, target.op),
				compensates: [target.seq],
			});
		});
	}

	revertAuthor(contentHash: string, author: IAuthor, actor: IAuthor = LOCAL_AUTHOR): Promise<number> {
		return this.queueEdit(contentHash, async () => {
			await this.load(contentHash);
			const log = this.logs.get(contentHash)!;
			const active = activeLogEdits(log.log);
			const targets = active.filter(edit =>
				edit.status === EditStatus.Accepted
				&& edit.compensates === undefined
				&& sameAuthor(edit.author, author)
			);
			if (targets.length === 0) {
				return 0;
			}

			const desired = InterpretationLog.from(active.filter(edit => !sameAuthor(edit.author, author)));
			const fields = new Map<string, IEdit[]>();
			for (const edit of targets) {
				const key = `${edit.anchor.contentHash}:${edit.anchor.rva.toString(16)}:${edit.op}`;
				const existing = fields.get(key);
				if (existing) {
					existing.push(edit);
				} else {
					fields.set(key, [edit]);
				}
			}

			let count = 0;
			for (const edits of fields.values()) {
				const field = edits[edits.length - 1];
				await this.appendPersisted(contentHash, {
					author: actor,
					anchor: field.anchor,
					op: field.op,
					value: desired.valueAt(field.anchor, field.op),
					compensates: edits.map(edit => edit.seq),
				});
				count++;
			}
			return count;
		});
	}

	exportTo(contentHash: string, destinationPath: string): Promise<number> {
		return this.queueEdit(contentHash, async () => {
			await this.load(contentHash);
			return this.storeService.exportLog(contentHash, destinationPath);
		});
	}

	importFrom(contentHash: string, sourcePath: string): Promise<number> {
		return this.queueEdit(contentHash, async () => {
			await this.load(contentHash);
			const imported = (await this.storeService.importLog(contentHash, sourcePath)).map(editFromWire);
			if (imported.length === 0) {
				return 0;
			}
			const existing = this.logs.get(contentHash)?.log ?? [];
			this.logs.set(contentHash, InterpretationLog.from([...existing, ...imported]));
			for (const edit of imported) {
				this._onDidChange.fire({ edit });
			}
			return imported.length;
		});
	}

	logFor(contentHash: string): readonly IEdit[] {
		return this.logs.get(contentHash)?.log ?? [];
	}

	private async appendPersisted(contentHash: string, request: Parameters<InterpretationLog['append']>[0]): Promise<IEdit> {
		const log = this.logs.get(contentHash)!;
		const next = InterpretationLog.from(log.log);
		const edit = next.append(request);
		await this.storeService.append(contentHash, editToWire(edit));
		this.logs.set(contentHash, next);
		this._onDidChange.fire({ edit });
		return edit;
	}

	private queueEdit<T>(contentHash: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.edits.get(contentHash) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(() => undefined, () => undefined);
		this.edits.set(contentHash, tail);
		void tail.finally(() => {
			if (this.edits.get(contentHash) === tail) {
				this.edits.delete(contentHash);
			}
		});
		return result;
	}
}

function sameAuthor(left: IAuthor, right: IAuthor): boolean {
	return left.kind === right.kind && left.id === right.id;
}

function compensatedSequences(edits: readonly IEdit[]): Set<number> {
	const compensated = new Set<number>();
	for (const edit of edits) {
		if (edit.status === EditStatus.Accepted) {
			for (const seq of edit.compensates ?? []) {
				compensated.add(seq);
			}
		}
	}
	return compensated;
}

function activeLogEdits(edits: readonly IEdit[]): readonly IEdit[] {
	const compensated = compensatedSequences(edits);
	return edits.filter(edit => edit.compensates === undefined && !compensated.has(edit.seq));
}

registerSingleton(IDelverInterpretationService, DelverInterpretationService, InstantiationType.Delayed);
