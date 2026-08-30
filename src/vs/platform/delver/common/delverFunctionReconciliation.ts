/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FunctionSourceWire } from './protocol.generated.js';

/**
 * How one decompiler backend's function set compares to Delver's.
 *
 * Delver's set is the reference frame every backend is reconciled against, and
 * against nothing else — adding a backend is one more reconciliation, never a
 * new pairwise relationship (ADR 0017). The comparison itself is deliberately
 * dumb: it classifies, and nothing here decides who was right. Ranking a
 * disagreement needs a heuristic, and a heuristic that lives in the join takes
 * the corpus with it when it turns out to be wrong.
 */

/** One function entry as Delver recovered it. */
export interface IDelverFunctionBoundary {
	readonly rva: bigint;
	/** Exclusive end, when the source records one. */
	readonly endRva: bigint | undefined;
	/** Why Delver believes this boundary. */
	readonly source: FunctionSourceWire;
}

/** One function entry as a decompiler backend recovered it. */
export interface IBackendFunctionBoundary {
	readonly rva: bigint;
	readonly endRva: bigint | undefined;
	/** The backend's own name for it, when it has one worth carrying. */
	readonly name: string | undefined;
}

/**
 * What the two sides said about one entry RVA.
 *
 * `DelverOnly` is the class that produces an unclickable name in pseudocode:
 * Delver knows the function, the backend that generated the text did not.
 */
export const enum FunctionAgreement {
	/** Both recovered the entry, and their bounds match. */
	Agree = 'agree',
	/** Both recovered the entry, with different ends. */
	BoundsDiffer = 'boundsDiffer',
	/** Delver recovered it; the backend did not. */
	DelverOnly = 'delverOnly',
	/** The backend recovered it; Delver did not. */
	BackendOnly = 'backendOnly',
}

/** One entry RVA, and what each side said about it. */
export interface IFunctionReconciliationRow {
	readonly rva: bigint;
	readonly agreement: FunctionAgreement;
	/** Absent exactly when `agreement` is `BackendOnly`. */
	readonly delver: IDelverFunctionBoundary | undefined;
	/** Absent exactly when `agreement` is `DelverOnly`. */
	readonly backend: IBackendFunctionBoundary | undefined;
}

/** Every entry RVA either side recovered, for one backend. */
export interface IFunctionReconciliation {
	readonly backendId: string;
	/**
	 * One row per RVA in the union of both sets, ascending.
	 *
	 * Total on purpose. The agreeing rows are not noise: without them a later
	 * pass cannot express a disagreement as a rate, only as a count.
	 */
	readonly rows: readonly IFunctionReconciliationRow[];
}

/** Counts per agreement class, for one reconciliation. */
export interface IFunctionReconciliationTotals {
	readonly agree: number;
	readonly boundsDiffer: number;
	readonly delverOnly: number;
	readonly backendOnly: number;
}

/**
 * Joins Delver's function set against one backend's over the union of entry
 * RVAs.
 *
 * Pure and total: every RVA either side names yields exactly one row, in
 * ascending order, and duplicate entries for one RVA on either side are refused
 * rather than silently collapsed — a set that names an address twice is not a
 * set, and picking one of the two would decide the very question the
 * reconciliation exists to expose.
 *
 * Inputs need not be sorted.
 */
export function reconcileFunctions(
	backendId: string,
	delverFunctions: readonly IDelverFunctionBoundary[],
	backendFunctions: readonly IBackendFunctionBoundary[],
): IFunctionReconciliation {
	const delverByRva = indexUnique(delverFunctions, 'Delver');
	const backendByRva = indexUnique(backendFunctions, `backend '${backendId}'`);

	const rvas = new Set<bigint>();
	for (const rva of delverByRva.keys()) {
		rvas.add(rva);
	}
	for (const rva of backendByRva.keys()) {
		rvas.add(rva);
	}

	const rows: IFunctionReconciliationRow[] = [];
	for (const rva of [...rvas].sort(compareRva)) {
		const delver = delverByRva.get(rva);
		const backend = backendByRva.get(rva);
		rows.push({ rva, agreement: classify(delver, backend), delver, backend });
	}

	return { backendId, rows };
}

/** Counts each agreement class. */
export function reconciliationTotals(reconciliation: IFunctionReconciliation): IFunctionReconciliationTotals {
	let agree = 0;
	let boundsDiffer = 0;
	let delverOnly = 0;
	let backendOnly = 0;
	for (const row of reconciliation.rows) {
		switch (row.agreement) {
			case FunctionAgreement.Agree: agree++; break;
			case FunctionAgreement.BoundsDiffer: boundsDiffer++; break;
			case FunctionAgreement.DelverOnly: delverOnly++; break;
			case FunctionAgreement.BackendOnly: backendOnly++; break;
		}
	}
	return { agree, boundsDiffer, delverOnly, backendOnly };
}

/**
 * Whether something in the image vouches for a boundary, as opposed to Delver
 * having guessed at it.
 *
 * Mirrors `FunctionSource::is_vouched` on the Rust side. A `LinearSweep`
 * boundary is a guess and its own source comments say so, which is why a
 * `DelverOnly` row is not on its own evidence that a backend missed something.
 * This is the input a later adjudication pass ranks by; it is not a verdict.
 */
export function isVouched(source: FunctionSourceWire): boolean {
	return source !== FunctionSourceWire.LinearSweep;
}

function classify(
	delver: IDelverFunctionBoundary | undefined,
	backend: IBackendFunctionBoundary | undefined,
): FunctionAgreement {
	if (!backend) {
		return FunctionAgreement.DelverOnly;
	}
	if (!delver) {
		return FunctionAgreement.BackendOnly;
	}
	// An end neither side claims is agreement about the entry, not a difference.
	// One side claiming an end the other leaves open is a real disagreement:
	// they do not describe the same extent.
	return delver.endRva === backend.endRva ? FunctionAgreement.Agree : FunctionAgreement.BoundsDiffer;
}

function indexUnique<T extends { readonly rva: bigint }>(boundaries: readonly T[], owner: string): Map<bigint, T> {
	const byRva = new Map<bigint, T>();
	for (const boundary of boundaries) {
		if (byRva.has(boundary.rva)) {
			throw new Error(`${owner} named 0x${boundary.rva.toString(16)} more than once`);
		}
		byRva.set(boundary.rva, boundary);
	}
	return byRva;
}

function compareRva(left: bigint, right: bigint): number {
	if (left < right) {
		return -1;
	}
	return left > right ? 1 : 0;
}
