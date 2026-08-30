/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { adjudicate, DisagreementKind } from '../../common/delverFunctionAdjudication.js';
import { reconcileFunctions } from '../../common/delverFunctionReconciliation.js';
import { FunctionSourceWire } from '../../common/protocol.generated.js';

function delverFn(rva: bigint, endRva: bigint | undefined, source = FunctionSourceWire.ExceptionDirectory) {
	return { rva, endRva, source };
}

function backendFn(rva: bigint, endRva: bigint | undefined) {
	return { rva, endRva, name: undefined };
}

function kinds(delver: Parameters<typeof reconcileFunctions>[1], backend: Parameters<typeof reconcileFunctions>[2]) {
	return adjudicate(reconcileFunctions('ida-idalib', delver, backend)).rows.map(row => [row.rva, row.kind]);
}

suite('Delver function adjudication', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('containment separates a boundary dispute from a coverage gap', () => {
		// 0x1100 is a Delver entry inside a backend function: the two carved the
		// same bytes differently. 0x9000 is in a region the backend has nothing
		// for at all. Before this pass both were "delverOnly" and indistinguishable.
		assert.deepStrictEqual(
			kinds(
				[delverFn(0x1000n, 0x1100n), delverFn(0x1100n, 0x1200n), delverFn(0x9000n, 0x9010n)],
				[backendFn(0x1000n, 0x1200n)],
			),
			[
				[0x1000n, DisagreementKind.ExtentDispute],
				[0x1100n, DisagreementKind.BoundaryDispute],
				[0x9000n, DisagreementKind.BackendCoverageGap],
			],
		);
	});

	test('containment is judged in both directions', () => {
		assert.deepStrictEqual(
			kinds(
				[delverFn(0x1000n, 0x1200n)],
				[backendFn(0x1000n, 0x1200n), backendFn(0x1100n, 0x1200n), backendFn(0x9000n, 0x9010n)],
			),
			[
				[0x1000n, DisagreementKind.Agreement],
				[0x1100n, DisagreementKind.BoundaryDispute],
				[0x9000n, DisagreementKind.DelverCoverageGap],
			],
		);
	});

	test('a side with no recorded end contains nothing, rather than reaching to the next entry', () => {
		// Inferring an end from the next entry would manufacture exactly the
		// containment this pass reads as evidence.
		assert.deepStrictEqual(
			kinds(
				[delverFn(0x1100n, 0x1200n, FunctionSourceWire.LinearSweep)],
				[backendFn(0x1000n, undefined)],
			),
			[
				[0x1000n, DisagreementKind.DelverCoverageGap],
				[0x1100n, DisagreementKind.BackendCoverageGap],
			],
		);
	});

	test('an entry equal to a start is the same function, never inside it', () => {
		assert.deepStrictEqual(
			kinds([delverFn(0x1000n, 0x1100n)], [backendFn(0x1000n, 0x1100n)]),
			[[0x1000n, DisagreementKind.Agreement]],
		);
	});

	test('a disagreement piled into one source is reported as concentrated', () => {
		// The shape the chained-fragment defect made: every disputed boundary
		// wearing the same, most authoritative, source.
		const delver = [delverFn(0x1000n, 0x9000n)];
		const backend = [backendFn(0x1000n, 0x9000n)];
		for (let index = 0; index < 10; index++) {
			delver.push(delverFn(BigInt(0x2000 + index * 0x100), BigInt(0x2000 + index * 0x100 + 0x80)));
		}

		const concentration = adjudicate(reconcileFunctions('ida-idalib', delver, backend)).concentrations
			.find(entry => entry.kind === DisagreementKind.BoundaryDispute);

		assert.deepStrictEqual(
			{ total: concentration?.total, concentratedIn: concentration?.concentratedIn },
			{ total: 10, concentratedIn: FunctionSourceWire.ExceptionDirectory },
		);
	});

	test('a disagreement spread across sources is not, and neither is a handful', () => {
		const spread = [delverFn(0x1000n, 0x9000n)];
		const sources = [
			FunctionSourceWire.ExceptionDirectory,
			FunctionSourceWire.LinearSweep,
			FunctionSourceWire.CallTarget,
		];
		for (let index = 0; index < 12; index++) {
			spread.push(delverFn(BigInt(0x2000 + index * 0x100), BigInt(0x2000 + index * 0x100 + 0x80), sources[index % 3]));
		}
		const spreadResult = adjudicate(reconcileFunctions('b', spread, [backendFn(0x1000n, 0x9000n)]))
			.concentrations.find(entry => entry.kind === DisagreementKind.BoundaryDispute);

		// Same uniform source, but too few rows to read anything into.
		const few = [delverFn(0x1000n, 0x9000n), delverFn(0x2000n, 0x2080n), delverFn(0x3000n, 0x3080n)];
		const fewResult = adjudicate(reconcileFunctions('b', few, [backendFn(0x1000n, 0x9000n)]))
			.concentrations.find(entry => entry.kind === DisagreementKind.BoundaryDispute);

		assert.deepStrictEqual(
			[spreadResult?.concentratedIn, fewResult?.concentratedIn, fewResult?.total],
			[undefined, undefined, 2],
		);
	});
});
