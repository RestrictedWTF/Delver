/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

import { ILocation, IRange } from '../../../../platform/delver/common/address.js';
import { IMoment, STATIC_MOMENT } from '../../../../platform/delver/common/moment.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IDelverFocusService = createDecorator<IDelverFocusService>('delverFocusService');

/**
 * What every synchronized Delver view is currently looking at.
 *
 * Every field is optional except the moment: a workspace with no target
 * attached still has a coherent focus, it just points at nothing.
 */
export interface IDelverFocus {
	readonly moment: IMoment;
	readonly location?: ILocation;
	readonly selection?: IRange;
	/** Exact discontiguous ranges represented by the focused semantic item. */
	readonly selections?: readonly IRange[];
}

/**
 * Why the focus moved. Views use this to decide how loudly to react — a `user`
 * navigation may scroll and flash, a `targetEvent` should not steal the caret.
 */
export const enum FocusReason {
	User = 'user',
	Navigation = 'navigation',
	TargetEvent = 'targetEvent',
	Script = 'script',
	Ai = 'ai',
}

export interface IDelverFocusChangeEvent {
	readonly focus: IDelverFocus;
	readonly previous: IDelverFocus;

	/**
	 * Identity of whatever caused the change.
	 *
	 * A view must ignore events carrying its own origin. Without this, two
	 * views that can each scroll the other will ping-pong updates forever —
	 * which is the failure mode that makes naive "everything is synchronized"
	 * designs unusable.
	 */
	readonly origin: string;
	readonly reason: FocusReason;
}

/**
 * A partial focus change. `undefined` keeps the current value, `null` clears it.
 */
export interface IFocusUpdate {
	readonly moment?: IMoment;
	readonly location?: ILocation | null;
	readonly selection?: IRange | null;
	readonly selections?: readonly IRange[] | null;
}

/**
 * The synchronization bus. One owner of "where are we", broadcast to every view.
 */
export interface IDelverFocusService {
	readonly _serviceBrand: undefined;

	readonly focus: IDelverFocus;
	readonly onDidChangeFocus: Event<IDelverFocusChangeEvent>;

	/**
	 * Moves the focus.
	 *
	 * A field left `undefined` keeps its current value; pass `null` to clear
	 * one. Distinguishing the two by presence would need the `in` operator,
	 * and "omitted" versus "explicitly cleared" is worth stating in the type
	 * rather than inferring from the shape of the object.
	 */
	setFocus(update: IFocusUpdate, origin: string, reason: FocusReason): void;

	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	back(): void;
	forward(): void;
}

/**
 * Addresses within this distance of the previous entry do not create a new
 * history entry.
 *
 * Scrolling three instructions is not a navigation. Without coalescing, the
 * back button walks one instruction at a time and becomes useless — which is
 * how it behaves in several tools that shipped without it.
 */
const HISTORY_COALESCE_BYTES = 0x40n;

/**
 * Upper bound on retained history entries.
 */
const HISTORY_LIMIT = 200;

/**
 * Origin reported for a replayed history entry.
 *
 * Exported because views distinguish it from an ordinary change: stepping back
 * is something the user asked for, not another view moving them.
 */
export const FOCUS_HISTORY_ORIGIN = 'history';

export class DelverFocusService extends Disposable implements IDelverFocusService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeFocus = this._register(new Emitter<IDelverFocusChangeEvent>());
	readonly onDidChangeFocus = this._onDidChangeFocus.event;

	private _focus: IDelverFocus = { moment: STATIC_MOMENT };

	/** Navigation history. `index` points at the current entry. */
	private history: IDelverFocus[] = [];
	private index = -1;

	/** Set while replaying history, so back/forward do not append entries. */
	private navigating = false;

	get focus(): IDelverFocus {
		return this._focus;
	}

	get canGoBack(): boolean {
		return this.index > 0;
	}

	get canGoForward(): boolean {
		return this.index >= 0 && this.index < this.history.length - 1;
	}

	setFocus(update: IFocusUpdate, origin: string, reason: FocusReason): void {
		const previous = this._focus;
		const next: IDelverFocus = {
			moment: update.moment ?? previous.moment,
			location: update.location === undefined ? previous.location : (update.location ?? undefined),
			selection: update.selection === undefined ? previous.selection : (update.selection ?? undefined),
			// Exact semantic ranges belong to the location that published them. A
			// later location-only navigation must not leave stale pseudocode paint.
			selections: update.selections === undefined
				? (update.location === undefined ? previous.selections : undefined)
				: (update.selections ?? undefined),
		};

		if (isSameFocus(previous, next)) {
			return;
		}

		this._focus = next;
		if (!this.navigating) {
			this.record(next);
		}

		this._onDidChangeFocus.fire({ focus: next, previous, origin, reason });
	}

	back(): void {
		if (!this.canGoBack) {
			return;
		}
		this.index--;
		this.replay();
	}

	forward(): void {
		if (!this.canGoForward) {
			return;
		}
		this.index++;
		this.replay();
	}

	private replay(): void {
		const entry = this.history[this.index];
		this.navigating = true;
		try {
			this.setFocus(entry, FOCUS_HISTORY_ORIGIN, FocusReason.Navigation);
		} finally {
			this.navigating = false;
		}
	}

	/**
	 * Appends to history, coalescing nearby positions and dropping any forward
	 * entries — a new navigation from the middle of history truncates the rest,
	 * matching how every back/forward stack behaves.
	 */
	private record(focus: IDelverFocus): void {
		const current = this.index >= 0 ? this.history[this.index] : undefined;
		if (current && isNearby(current, focus)) {
			this.history[this.index] = focus;
			return;
		}

		this.history.length = this.index + 1;
		this.history.push(focus);

		if (this.history.length > HISTORY_LIMIT) {
			this.history.shift();
		}
		this.index = this.history.length - 1;
	}
}

function isSameFocus(a: IDelverFocus, b: IDelverFocus): boolean {
	return (
		a.moment.kind === b.moment.kind &&
		a.moment.epoch === b.moment.epoch &&
		sameLocation(a.location, b.location) &&
		sameRange(a.selection, b.selection) &&
		sameRanges(a.selections, b.selections)
	);
}

function sameLocation(a: ILocation | undefined, b: ILocation | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.space === b.space && a.address === b.address;
}

function sameRange(a: IRange | undefined, b: IRange | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.start === b.start && a.end === b.end;
}

function sameRanges(a: readonly IRange[] | undefined, b: readonly IRange[] | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.length === b.length && a.every((range, index) => sameRange(range, b[index]));
}

registerSingleton(IDelverFocusService, DelverFocusService, InstantiationType.Delayed);

/**
 * Whether `next` is close enough to `current` to be the same navigation.
 */
function isNearby(current: IDelverFocus, next: IDelverFocus): boolean {
	if (!current.location || !next.location) {
		return false;
	}
	if (current.location.space !== next.location.space) {
		return false;
	}
	const a = current.location.address;
	const b = next.location.address;
	const distance = a > b ? a - b : b - a;
	return distance <= HISTORY_COALESCE_BYTES;
}
