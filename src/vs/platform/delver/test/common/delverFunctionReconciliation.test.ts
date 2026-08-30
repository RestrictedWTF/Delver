/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	FunctionAgreement,
	IBackendFunctionBoundary,
	IDelverFunctionBoundary,
	isVouched,
	reconcileFunctions,
	reconciliationTotals,
} from '../../common/delverFunctionReconciliation.js';
import { FunctionSourceWire } from '../../common/protocol.generated.js';

function delverFn(rva: bigint, endRva: bigint | undefined, source = FunctionSourceWire.ExceptionDirectory): IDelverFunctionBoundary {
	return { rva, endRva, source };
}

function backendFn(rva: bigint, endRva: bigint | undefined, name?: string): IBackendFunctionBoundary {
	return { rva, endRva, name };
}

suite('Delver function reconciliation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every RVA either side names yields one ascending row', () => {
		const reconciliation = reconcileFunctions(
			'ghidra-pyghidra',
			[delverFn(0x1d7a0n, 0x1d7aen), delverFn(0xe2a0n, 0x10dc0n)],
			[backendFn(0x2000n, 0x2100n, 'FUN_140002000'), backendFn(0xe2a0n, 0x10dc0n)],
		);

		assert.deepStrictEqual(reconciliation, {
			backendId: 'ghidra-pyghidra',
			rows: [
				{
					rva: 0x2000n,
					agreement: FunctionAgreement.BackendOnly,
					delver: undefined,
					backend: backendFn(0x2000n, 0x2100n, 'FUN_140002000'),
				},
				{
					rva: 0xe2a0n,
					agreement: FunctionAgreement.Agree,
					delver: delverFn(0xe2a0n, 0x10dc0n),
					backend: backendFn(0xe2a0n, 0x10dc0n),
				},
				{
					rva: 0x1d7a0n,
					agreement: FunctionAgreement.DelverOnly,
					delver: delverFn(0x1d7a0n, 0x1d7aen),
					backend: undefined,
				},
			],
		});
	});

	test('a shared entry with different ends is a disagreement, and an open end on one side is too', () => {
		const reconciliation = reconcileFunctions(
			'ghidra-pyghidra',
			[delverFn(0x1000n, 0x1100n), delverFn(0x2000n, undefined), delverFn(0x3000n, undefined)],
			[backendFn(0x1000n, 0x1200n), backendFn(0x2000n, 0x2100n), backendFn(0x3000n, undefined)],
		);

		assert.deepStrictEqual(reconciliation.rows.map(row => [row.rva, row.agreement]), [
			[0x1000n, FunctionAgreement.BoundsDiffer],
			[0x2000n, FunctionAgreement.BoundsDiffer],
			[0x3000n, FunctionAgreement.Agree],
		]);
	});

	test('totals count every class, including agreement', () => {
		const reconciliation = reconcileFunctions(
			'ghidra-pyghidra',
			[delverFn(0x1000n, 0x1100n), delverFn(0x2000n, 0x2100n), delverFn(0x3000n, 0x3100n)],
			[backendFn(0x1000n, 0x1100n), backendFn(0x2000n, 0x2200n), backendFn(0x4000n, 0x4100n)],
		);

		assert.deepStrictEqual(reconciliationTotals(reconciliation), {
			agree: 1,
			boundsDiffer: 1,
			delverOnly: 1,
			backendOnly: 1,
		});
	});

	test('unsorted input reconciles the same as sorted input', () => {
		const delver = [delverFn(0x3000n, undefined), delverFn(0x1000n, undefined), delverFn(0x2000n, undefined)];
		const backend = [backendFn(0x2000n, undefined), backendFn(0x3000n, undefined)];

		assert.deepStrictEqual(
			reconcileFunctions('b', delver, backend).rows.map(row => row.rva),
			[0x1000n, 0x2000n, 0x3000n],
		);
	});

	test('a side that names one RVA twice is refused rather than collapsed', () => {
		assert.throws(
			() => reconcileFunctions('ghidra-pyghidra', [delverFn(0x1000n, 0x1100n), delverFn(0x1000n, 0x1200n)], []),
			/Delver named 0x1000 more than once/,
		);
		assert.throws(
			() => reconcileFunctions('ghidra-pyghidra', [], [backendFn(0x1000n, undefined), backendFn(0x1000n, undefined)]),
			/backend 'ghidra-pyghidra' named 0x1000 more than once/,
		);
	});

	test('an empty backend set makes every Delver function a disagreement, not an agreement', () => {
		const reconciliation = reconcileFunctions('ghidra-pyghidra', [delverFn(0x1000n, 0x1100n)], []);

		assert.deepStrictEqual(reconciliationTotals(reconciliation), {
			agree: 0,
			boundsDiffer: 0,
			delverOnly: 1,
			backendOnly: 0,
		});
	});

	test('only a linear-sweep boundary is unvouched', () => {
		assert.deepStrictEqual(
			[
				FunctionSourceWire.Authored,
				FunctionSourceWire.ExceptionDirectory,
				FunctionSourceWire.EntryPoint,
				FunctionSourceWire.Export,
				FunctionSourceWire.TlsCallback,
				FunctionSourceWire.CallTarget,
				FunctionSourceWire.LinearSweep,
			].map(isVouched),
			[true, true, true, true, true, true, false],
		);
	});
});
