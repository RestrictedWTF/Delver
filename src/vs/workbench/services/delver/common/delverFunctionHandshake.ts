/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDelverBackendFunctionsWire } from '../../../../platform/delver/common/delverAnalysisService.js';
import { adjudicate, DisagreementKind, IAdjudication } from '../../../../platform/delver/common/delverFunctionAdjudication.js';
import { IBackendFunctionBoundary, IDelverFunctionBoundary, IFunctionReconciliation, reconcileFunctions, reconciliationTotals } from '../../../../platform/delver/common/delverFunctionReconciliation.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';

/**
 * One backend's function set compared to Delver's (ADR 0017).
 *
 * This is where the wire's `"0x…"` strings become `bigint`, on the renderer side
 * of the shared-process boundary and nowhere earlier.
 */
export interface IFunctionHandshake {
	readonly reconciliation: IFunctionReconciliation;
	readonly adjudication: IAdjudication;
	readonly summary: IHandshakeSummary;
}

/** The counts worth showing without reading every row. */
export interface IHandshakeSummary {
	readonly backendId: string;
	readonly delverFunctions: number;
	readonly backendFunctions: number;
	readonly agree: number;
	readonly extentDisputes: number;
	readonly boundaryDisputes: number;
	readonly backendCoverageGaps: number;
	readonly delverCoverageGaps: number;
	/**
	 * Kinds a single `FunctionSource` accounts for most of.
	 *
	 * The signal that made the chained-fragment defect legible: a disagreement
	 * piled into one source is a claim about the code that reads that source.
	 * Advisory, and named as such — it points an investigation somewhere rather
	 * than concluding one.
	 */
	readonly concentrations: readonly (readonly [DisagreementKind, string])[];
}

/**
 * Runs the handshake for one backend.
 *
 * A function whose `fragments` place part of it elsewhere still reconciles on
 * its entry alone: the two sides are being compared on where functions *start*,
 * and folding a discontiguous extent into that comparison would conflate two
 * different disagreements.
 */
export function handshake(
	delverFunctions: readonly IFunctionWire[],
	backend: IDelverBackendFunctionsWire,
): IFunctionHandshake {
	const reconciliation = reconcileFunctions(
		backend.backendId,
		delverFunctions.map(readDelverFunction),
		backend.functions.map(readBackendFunction),
	);
	const adjudication = adjudicate(reconciliation);
	const totals = reconciliationTotals(reconciliation);

	const counted = new Map<DisagreementKind, number>();
	for (const row of adjudication.rows) {
		counted.set(row.kind, (counted.get(row.kind) ?? 0) + 1);
	}

	return {
		reconciliation,
		adjudication,
		summary: {
			backendId: backend.backendId,
			delverFunctions: delverFunctions.length,
			backendFunctions: backend.functions.length,
			agree: totals.agree,
			extentDisputes: counted.get(DisagreementKind.ExtentDispute) ?? 0,
			boundaryDisputes: counted.get(DisagreementKind.BoundaryDispute) ?? 0,
			backendCoverageGaps: counted.get(DisagreementKind.BackendCoverageGap) ?? 0,
			delverCoverageGaps: counted.get(DisagreementKind.DelverCoverageGap) ?? 0,
			concentrations: adjudication.concentrations
				.filter(entry => entry.concentratedIn !== undefined)
				.map(entry => [entry.kind, entry.concentratedIn!] as const),
		},
	};
}

function readDelverFunction(wire: IFunctionWire): IDelverFunctionBoundary {
	return {
		rva: BigInt(wire.rva),
		endRva: wire.end_rva === undefined ? undefined : BigInt(wire.end_rva),
		source: wire.source,
	};
}

function readBackendFunction(wire: { readonly rva: string; readonly endRva: string | undefined; readonly name: string }): IBackendFunctionBoundary {
	return {
		rva: BigInt(wire.rva),
		endRva: wire.endRva === undefined ? undefined : BigInt(wire.endRva),
		name: wire.name,
	};
}
