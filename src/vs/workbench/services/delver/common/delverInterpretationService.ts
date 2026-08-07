/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	Anchor,
	EditOp,
	IAuthor,
	IEdit,
	IInterpretationAt,
	InterpretationLog,
} from '../../../../platform/delver/common/interpretation.js';
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
	edit(anchor: Anchor, op: EditOp, value: string, author?: IAuthor): IEdit;

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

	edit(anchor: Anchor, op: EditOp, value: string, author: IAuthor = LOCAL_AUTHOR): IEdit {
		let log = this.logs.get(anchor.contentHash);
		if (!log) {
			log = new InterpretationLog();
			this.logs.set(anchor.contentHash, log);
		}
		const edit = log.append({ author, anchor, op, value });
		this._onDidChange.fire({ edit });
		return edit;
	}

	logFor(contentHash: string): readonly IEdit[] {
		return this.logs.get(contentHash)?.log ?? [];
	}
}

registerSingleton(IDelverInterpretationService, DelverInterpretationService, InstantiationType.Delayed);
