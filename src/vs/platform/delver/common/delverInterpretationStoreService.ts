/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { EditOp, EditStatus, IEdit } from './interpretation.js';

export const IDelverInterpretationStoreService = createDecorator<IDelverInterpretationStoreService>('delverInterpretationStoreService');

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Whether `value` is the canonical SHA-256 identity used for image anchors. */
export function isContentHash(value: unknown): value is string {
	return typeof value === 'string' && CONTENT_HASH.test(value);
}

/** An interpretation edit in its JSON- and IPC-safe representation. */
export interface IInterpretationEditWire {
	readonly seq: number;
	readonly at: number;
	readonly author: {
		readonly kind: 'human' | 'rule' | 'model' | 'import';
		readonly id: string;
	};
	readonly anchor: {
		readonly kind: 'image';
		readonly contentHash: string;
		/** RVA as a `"0x..."` string. Bigints never cross a process boundary. */
		readonly rva: string;
	};
	readonly op: EditOp;
	readonly value: string;
	readonly status: EditStatus;
}

/** Persistence for authored interpretation, hosted in the shared process. */
export interface IDelverInterpretationStoreService {
	readonly _serviceBrand: undefined;

	/** Loads and validates the append-only log for one image. */
	load(contentHash: string): Promise<readonly IInterpretationEditWire[]>;

	/** Appends exactly one JSONL record. */
	append(contentHash: string, edit: IInterpretationEditWire): Promise<void>;

	/** Copies the image's JSONL log to a user-selected path. */
	exportLog(contentHash: string, destinationPath: string): Promise<number>;

	/** Appends a user-selected JSONL log and returns the imported edits. */
	importLog(contentHash: string, sourcePath: string): Promise<readonly IInterpretationEditWire[]>;
}

export function editToWire(edit: IEdit): IInterpretationEditWire {
	return {
		...edit,
		anchor: {
			...edit.anchor,
			rva: `0x${edit.anchor.rva.toString(16)}`,
		},
	};
}

export function editFromWire(edit: IInterpretationEditWire): IEdit {
	return {
		...edit,
		anchor: {
			...edit.anchor,
			rva: BigInt(edit.anchor.rva),
		},
	};
}
