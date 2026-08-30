/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FunctionAgreement, IFunctionReconciliation, IFunctionReconciliationRow } from './delverFunctionReconciliation.js';
import { FunctionSourceWire } from './protocol.generated.js';

/**
 * What *kind* of disagreement a reconciliation row is.
 *
 * A separate pass over the join, never part of it (ADR 0017): classifying a
 * disagreement needs a rule, and the first rule this project tried was wrong.
 * That one read a vouched `FunctionSource` as evidence the backend had missed
 * something; measured against IDA 9.1 it was wrong 638 times out of 640,
 * because the vouched source was itself faulty.
 *
 * What replaced it is not provenance but **containment**, and it is a question
 * about the other side's answer rather than about our own confidence: does the
 * disputed address fall inside a function the other side already has? Measured
 * across four images after the fragment defect was fixed, every remaining
 * exception-directory disagreement fell *outside* any backend function — 23 of
 * 23, against 638 of 640 falling inside beforehand. Containment separated the
 * two populations cleanly where provenance did not separate them at all.
 *
 * This still classifies rather than decides. A `BoundaryDispute` says the two
 * sides carved the same bytes differently; it does not say which carving is
 * right.
 */
export const enum DisagreementKind {
	/** Both sides recovered this entry and agree on its extent. */
	Agreement = 'agreement',
	/**
	 * One side's entry falls strictly inside a function the other side already
	 * has. The bytes are code on both accounts; the sides disagree about where
	 * one function ends and the next begins.
	 */
	BoundaryDispute = 'boundaryDispute',
	/** Delver has an entry in a region the backend has no function for at all. */
	BackendCoverageGap = 'backendCoverageGap',
	/** The backend has an entry in a region Delver has no function for at all. */
	DelverCoverageGap = 'delverCoverageGap',
	/** Both recovered the entry and disagree only about where it ends. */
	ExtentDispute = 'extentDispute',
}

/** One classified row. */
export interface IAdjudicatedRow {
	readonly rva: bigint;
	readonly kind: DisagreementKind;
	/** Delver's source, when Delver has this entry. */
	readonly source: FunctionSourceWire | undefined;
}

/** Counts per source for one disagreement kind. */
export interface ISourceConcentration {
	readonly kind: DisagreementKind;
	readonly total: number;
	/** Counts by Delver's `FunctionSource`, descending, ties broken by name. */
	readonly bySource: readonly (readonly [FunctionSourceWire, number])[];
	/**
	 * Whether one source accounts for most of this kind.
	 *
	 * The signal that made the fragment defect legible: a disagreement piled
	 * into a single source is a claim about the code that reads that source,
	 * while one spread across sources is a claim about individual addresses.
	 * Advisory — it points an investigation somewhere, it does not conclude one.
	 */
	readonly concentratedIn: FunctionSourceWire | undefined;
}

/** Every row classified, with the per-kind concentration summary. */
export interface IAdjudication {
	readonly backendId: string;
	readonly rows: readonly IAdjudicatedRow[];
	readonly concentrations: readonly ISourceConcentration[];
}

/**
 * Fraction of one kind a single source must account for to be called
 * concentrated.
 *
 * Two thirds, chosen to sit well clear of both observed populations rather than
 * to fit either: the fragment defect put 99.7% of `delverOnly` into one source,
 * and the same images after the fix put no source above a third. Nothing yet
 * distinguishes 0.6 from 0.7, so this is a threshold to revisit against more
 * images, not a tuned constant.
 */
const CONCENTRATION_SHARE = 2 / 3;

/** Minimum rows of a kind before concentration is reported at all. */
const CONCENTRATION_FLOOR = 8;

/**
 * Classifies every row of one reconciliation.
 *
 * Pure, and total over the reconciliation's rows: a row in yields exactly one
 * row out, in the same order.
 */
export function adjudicate(reconciliation: IFunctionReconciliation): IAdjudication {
	const delverExtents = extentsOf(reconciliation.rows, row => row.delver);
	const backendExtents = extentsOf(reconciliation.rows, row => row.backend);

	const rows = reconciliation.rows.map((row): IAdjudicatedRow => ({
		rva: row.rva,
		kind: classify(row, delverExtents, backendExtents),
		source: row.delver?.source,
	}));

	return { backendId: reconciliation.backendId, rows, concentrations: concentrations(rows) };
}

function classify(
	row: IFunctionReconciliationRow,
	delverExtents: readonly Extent[],
	backendExtents: readonly Extent[],
): DisagreementKind {
	switch (row.agreement) {
		case FunctionAgreement.Agree:
			return DisagreementKind.Agreement;
		case FunctionAgreement.BoundsDiffer:
			return DisagreementKind.ExtentDispute;
		case FunctionAgreement.DelverOnly:
			return containedBy(row.rva, backendExtents)
				? DisagreementKind.BoundaryDispute
				: DisagreementKind.BackendCoverageGap;
		case FunctionAgreement.BackendOnly:
			return containedBy(row.rva, delverExtents)
				? DisagreementKind.BoundaryDispute
				: DisagreementKind.DelverCoverageGap;
	}
}

interface Extent {
	readonly start: bigint;
	readonly end: bigint;
}

function extentsOf(
	rows: readonly IFunctionReconciliationRow[],
	pick: (row: IFunctionReconciliationRow) => { readonly rva: bigint; readonly endRva: bigint | undefined } | undefined,
): readonly Extent[] {
	const extents: Extent[] = [];
	for (const row of rows) {
		const boundary = pick(row);
		// A side that records no end makes no claim about how far its function
		// reaches, so it cannot contain anything. Inferring an end from the next
		// entry would manufacture the containment this pass reads as evidence.
		if (boundary?.endRva !== undefined) {
			extents.push({ start: boundary.rva, end: boundary.endRva });
		}
	}
	return extents;
}

/** Strictly inside — an entry equal to a start is the same entry, not inside it. */
function containedBy(rva: bigint, extents: readonly Extent[]): boolean {
	return extents.some(extent => rva > extent.start && rva < extent.end);
}

function concentrations(rows: readonly IAdjudicatedRow[]): readonly ISourceConcentration[] {
	const kinds = [
		DisagreementKind.BoundaryDispute,
		DisagreementKind.BackendCoverageGap,
		DisagreementKind.DelverCoverageGap,
		DisagreementKind.ExtentDispute,
	];
	return kinds.map(kind => {
		const counts = new Map<FunctionSourceWire, number>();
		let total = 0;
		for (const row of rows) {
			if (row.kind !== kind) {
				continue;
			}
			total++;
			if (row.source !== undefined) {
				counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
			}
		}
		const bySource = [...counts.entries()].sort(
			(left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
		);
		const leader = bySource[0];
		const concentratedIn = total >= CONCENTRATION_FLOOR && leader && leader[1] >= total * CONCENTRATION_SHARE
			? leader[0]
			: undefined;
		return { kind, total, bySource, concentratedIn };
	});
}
