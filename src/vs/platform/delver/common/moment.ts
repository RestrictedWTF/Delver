/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kind of moment represented by a target read.
 *
 * Five kinds, and each names a different guarantee rather than a shade of one
 * ([ADR 0018](../../../../../Docs/history/adr/0018-one-moment-taxonomy.md)).
 * Only `Static` is produced today; the rest are reserved so a `switch` written
 * now is exhaustive over the axis P4 and P7 will use, and so the compiler asks
 * the next consumer rather than a later migration doing it.
 */
export const enum MomentKind {
	/** Content cannot change. A file on disk. Cacheable forever. */
	Static = 'static',
	/**
	 * A live target, halted. Reads within the epoch are coherent and may be
	 * cached aggressively. Produced by the debugger provider at P4.
	 */
	Frozen = 'frozen',
	/**
	 * A captured, immutable state of a live target.
	 *
	 * Distinct from {@link MomentKind.Static}: a snapshot can be stale relative
	 * to the process it came from, and a file has nothing to be stale against.
	 */
	Snapshot = 'snapshot',
	/**
	 * Running. Reads may observe change between calls and may tear, so they are
	 * cached for milliseconds at most and must be labelled stale in the UI and
	 * in AI tool results.
	 */
	Live = 'live',
	/**
	 * A position within a recorded execution trace. {@link IMoment.epoch}
	 * carries the position.
	 */
	Replay = 'replay',
}

/**
 * A point in time at which target data was observed.
 *
 * `epoch` is the only positional field, deliberately: it already carries a
 * provider-stamped `u64`, which is what a trace position is, and a second
 * monotonic counter would be null for every provider but one (ADR 0018).
 */
export interface IMoment {
	readonly kind: MomentKind;
	/** Monotonic per target. Bumped whenever observable state may have changed. */
	readonly epoch: bigint;
}

/**
 * The constant moment used by static providers.
 */
export const STATIC_MOMENT: IMoment = Object.freeze({
	kind: MomentKind.Static,
	epoch: 0n,
});
