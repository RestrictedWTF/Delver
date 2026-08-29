/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Anchor, EditOp, EditStatus, IEdit, IPendingEdit } from './interpretation.js';

export const IDelverInterpretationStoreService = createDecorator<IDelverInterpretationStoreService>('delverInterpretationStoreService');

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Whether `value` is the canonical SHA-256 identity used for image anchors. */
export function isContentHash(value: unknown): value is string {
	return typeof value === 'string' && CONTENT_HASH.test(value);
}

/**
 * Wire form of an anchor.
 *
 * A discriminated union rather than one shape with optional fields: a reader
 * that has not been taught about `type` must fail to parse it, not silently
 * treat a named composite as an edit at RVA 0.
 */
export type IInterpretationAnchorWire =
	| {
		readonly kind: 'image';
		readonly contentHash: string;
		/** RVA as a `"0x..."` string. Bigints never cross a process boundary. */
		readonly rva: string;
	}
	| {
		readonly kind: 'type';
		readonly contentHash: string;
		readonly name: string;
	};

/** An interpretation edit in its JSON- and IPC-safe representation. */
export interface IInterpretationEditWire {
	readonly seq: number;
	readonly at: number;
	readonly author: {
		readonly kind: 'human' | 'rule' | 'model' | 'import';
		readonly id: string;
	};
	readonly anchor: IInterpretationAnchorWire;
	readonly op: EditOp;
	readonly value: IEdit['value'];
	readonly status: EditStatus;
	readonly compensates?: readonly number[];
	readonly resolves?: readonly number[];
}

/**
 * One interpretation edit before the store has allocated its sequence.
 *
 * A sequence minted in a renderer is minted against a *copy* of the log. Two
 * windows on the same image both reach the same next number, and the write that
 * lands second collides with the first — silently, if the store discards it.
 * The shared-process store is the only place that sees every stored edit, so it
 * is the only place that can allocate.
 */
export type IInterpretationEditRequestWire = Omit<IInterpretationEditWire, 'seq'>;

/** Persistence for authored interpretation, hosted in the shared process. */
export interface IDelverInterpretationStoreService {
	readonly _serviceBrand: undefined;

	/** Loads and validates the append-only log for one image. */
	load(contentHash: string): Promise<readonly IInterpretationEditWire[]>;

	/**
	 * Appends exactly one JSONL record, allocating its sequence, and returns the
	 * record as stored.
	 *
	 * `minimumSeq` is the caller's own next free sequence. The store allocates
	 * above both its own high-water mark and that floor, so an edit stays unique
	 * against a log the caller holds but the store has not seen — the log of a
	 * project opened from a `.delverdb`, for instance.
	 */
	append(contentHash: string, edit: IInterpretationEditRequestWire, minimumSeq?: number): Promise<IInterpretationEditWire>;

	/** Copies the image's JSONL log to a user-selected path. */
	exportLog(contentHash: string, destinationPath: string): Promise<number>;

	/** Appends a user-selected JSONL log and returns the imported edits. */
	importLog(contentHash: string, sourcePath: string): Promise<readonly IInterpretationEditWire[]>;
}

function anchorToWire(anchor: Anchor): IInterpretationAnchorWire {
	return anchor.kind === 'type'
		? { kind: 'type', contentHash: anchor.contentHash, name: anchor.name }
		: { kind: 'image', contentHash: anchor.contentHash, rva: `0x${anchor.rva.toString(16)}` };
}

function anchorFromWire(anchor: IInterpretationAnchorWire): Anchor {
	return anchor.kind === 'type'
		? { kind: 'type', contentHash: anchor.contentHash, name: anchor.name }
		: { kind: 'image', contentHash: anchor.contentHash, rva: BigInt(anchor.rva) };
}

export function editToWire(edit: IEdit): IInterpretationEditWire {
	return {
		...edit,
		anchor: anchorToWire(edit.anchor),
	};
}

/** Wire form of an edit still waiting for the store to allocate its sequence. */
export function editRequestToWire(edit: IPendingEdit): IInterpretationEditRequestWire {
	return {
		...edit,
		anchor: anchorToWire(edit.anchor),
	};
}

export function editFromWire(edit: IInterpretationEditWire): IEdit {
	return {
		...edit,
		anchor: anchorFromWire(edit.anchor),
	};
}
