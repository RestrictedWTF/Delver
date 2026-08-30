/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DisagreementKind } from '../../../../../platform/delver/common/delverFunctionAdjudication.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { handshake } from '../../common/delverFunctionHandshake.js';

function delverFn(rva: string, endRva: string | undefined, source = FunctionSourceWire.ExceptionDirectory): IFunctionWire {
	return { rva, end_rva: endRva, source, authoritative: true };
}

function backendFn(rva: string, endRva: string | undefined, name = 'FUN') {
	return { rva, endRva, name };
}

suite('Delver function handshake', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wire strings become bigint on this side of the boundary', () => {
		// The wire carries "0x…" strings precisely so an address above 2^53 is
		// not truncated by a JSON number (ADR 0001). Conversion happens here.
		const huge = '0x1fffffffffffff9';
		const result = handshake(
			[delverFn(huge, undefined)],
			{ backendId: 'b', backendVersion: '1', analysisComplete: true, functions: [backendFn(huge, undefined)] },
		);

		assert.deepStrictEqual(
			[result.reconciliation.rows[0].rva, result.summary.agree],
			[BigInt(huge), 1],
		);
	});

	test('a summary counts each kind of disagreement separately', () => {
		const result = handshake(
			[
				delverFn('0x1000', '0x1200'),
				delverFn('0x1100', '0x1200'),
				delverFn('0x9000', '0x9010'),
			],
			{
				backendId: 'ida-idalib',
				backendVersion: '9.1',
				analysisComplete: true,
				functions: [backendFn('0x1000', '0x1200'), backendFn('0x5000', '0x5010')],
			},
		);

		assert.deepStrictEqual(result.summary, {
			backendId: 'ida-idalib',
			delverFunctions: 3,
			backendFunctions: 2,
			agree: 1,
			extentDisputes: 0,
			boundaryDisputes: 1,
			backendCoverageGaps: 1,
			delverCoverageGaps: 1,
			concentrations: [],
		});
	});

	test('a disagreement piled into one source is surfaced in the summary', () => {
		// The shape the chained-fragment defect made, at the size it made it.
		const delver = [delverFn('0x1000', '0x9000')];
		for (let index = 0; index < 12; index++) {
			const start = 0x2000 + index * 0x100;
			delver.push(delverFn(`0x${start.toString(16)}`, `0x${(start + 0x80).toString(16)}`));
		}

		const result = handshake(delver, {
			backendId: 'ida-idalib',
			backendVersion: '9.1',
			analysisComplete: true,
			functions: [backendFn('0x1000', '0x9000')],
		});

		assert.deepStrictEqual(result.summary.concentrations, [
			[DisagreementKind.BoundaryDispute, FunctionSourceWire.ExceptionDirectory],
		]);
	});

	test('an empty backend set is a total disagreement, never an agreement', () => {
		const result = handshake(
			[delverFn('0x1000', '0x1100')],
			{ backendId: 'b', backendVersion: '1', analysisComplete: true, functions: [] },
		);

		assert.deepStrictEqual(
			[result.summary.agree, result.summary.backendCoverageGaps, result.summary.backendFunctions],
			[0, 1, 0],
		);
	});
});
