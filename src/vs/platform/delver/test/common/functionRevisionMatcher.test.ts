/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	FunctionRevisionMatchMethod,
	IFingerprintedFunction,
	IFunctionRevision,
	fingerprintFunctionListing,
	matchFunctionRevisions,
	normalizeFunctionListing,
} from '../../common/functionRevisionMatcher.js';
import { FlowKindWire, FunctionSourceWire, IFunctionWire, IListingRowWire } from '../../common/protocol.generated.js';

suite('Delver function revision matcher', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fn = (rva: string, endRva: string): IFunctionWire => ({
		authoritative: true,
		end_rva: endRva,
		rva,
		source: FunctionSourceWire.ExceptionDirectory,
	});

	const fingerprinted = (functionValue: IFunctionWire, digest: string, normalization = 'x86-relocations-v1'): IFingerprintedFunction => ({
		function: functionValue,
		fingerprint: { algorithm: 'sha256', normalization, digest },
	});

	const revision = (contentHash: string, functions: readonly IFingerprintedFunction[]): IFunctionRevision => ({ contentHash, functions });
	const row = (rowValue: number, rva: string, mnemonic: string, operands: string, flow = FlowKindWire.Sequential, branchTarget?: string): IListingRowWire => ({
		branch_target: branchTarget,
		flow,
		len: flow === FlowKindWire.Call || flow === FlowKindWire.Jump ? 5 : 1,
		mnemonic,
		operands,
		row: rowValue,
		rva,
	});

	test('normalizes row addresses and direct targets while retaining instruction facts', () => {
		const oldRows = [
			row(10, '0x1000', ' CMP ', ' EAX, 7 '),
			row(11, '0x1001', 'JNE', '0x1007', FlowKindWire.ConditionalJump, '0x1007'),
			row(12, '0x1007', 'RET', '', FlowKindWire.Return),
		];
		const newRows = [
			row(90, '0x5000', 'cmp', 'eax, 7'),
			row(91, '0x5001', 'jne', '0x5007', FlowKindWire.ConditionalJump, '0x5007'),
			row(92, '0x5007', 'ret', '', FlowKindWire.Return),
		];

		assert.deepStrictEqual(
			[normalizeFunctionListing(oldRows), fingerprintFunctionListing(oldRows)],
			[normalizeFunctionListing(newRows), fingerprintFunctionListing(newRows)],
		);
	});

	test('fingerprint retains immediates and distinguishes changed instruction content', () => {
		const first = [row(0, '0x1000', 'mov', 'eax, 7')];
		const second = [row(0, '0x5000', 'mov', 'eax, 8')];

		assert.notStrictEqual(fingerprintFunctionListing(first).digest, fingerprintFunctionListing(second).digest);
	});

	test('uses the standard SHA-256 digest for the canonical sequence', () => {
		assert.strictEqual(
			fingerprintFunctionListing([]).digest,
			'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
		);
	});

	test('matches a relocated function and exposes exact provenance', () => {
		const oldFunction = fn('0x1000', '0x1020');
		const newFunction = fn('0x5000', '0x5020');
		const result = matchFunctionRevisions(
			revision('old-image', [fingerprinted(oldFunction, 'AABB')]),
			revision('new-image', [fingerprinted(newFunction, 'aabb')]),
		);

		assert.deepStrictEqual(result, {
			matches: [{
				source: oldFunction,
				target: newFunction,
				confidence: 1,
				method: FunctionRevisionMatchMethod.NormalizedFingerprintExact,
				provenance: {
					sourceContentHash: 'old-image',
					targetContentHash: 'new-image',
					fingerprint: { algorithm: 'sha256', normalization: 'x86-relocations-v1', digest: 'aabb' },
				},
			}],
			ambiguous: [],
			unmatchedSource: [],
			unmatchedTarget: [],
		});
	});

	test('does not match fingerprints produced by different normalization profiles', () => {
		const oldFunction = fn('0x1000', '0x1020');
		const newFunction = fn('0x5000', '0x5020');
		const result = matchFunctionRevisions(
			revision('old-image', [fingerprinted(oldFunction, 'aabb', 'x86-relocations-v1')]),
			revision('new-image', [fingerprinted(newFunction, 'aabb', 'x86-structure-v1')]),
		);

		assert.deepStrictEqual(result, {
			matches: [],
			ambiguous: [],
			unmatchedSource: [oldFunction],
			unmatchedTarget: [newFunction],
		});
	});

	test('reports duplicate fingerprints as ambiguous instead of pairing by order', () => {
		const oldFunctions = [fn('0x1000', '0x1010'), fn('0x2000', '0x2010')];
		const newFunctions = [fn('0x7000', '0x7010'), fn('0x8000', '0x8010')];
		const result = matchFunctionRevisions(
			revision('old-image', oldFunctions.map(value => fingerprinted(value, 'ccdd'))),
			revision('new-image', newFunctions.map(value => fingerprinted(value, 'ccdd'))),
		);

		assert.deepStrictEqual(result, {
			matches: [],
			ambiguous: [{
				source: oldFunctions,
				target: newFunctions,
				method: FunctionRevisionMatchMethod.NormalizedFingerprintExact,
				provenance: {
					sourceContentHash: 'old-image',
					targetContentHash: 'new-image',
					fingerprint: { algorithm: 'sha256', normalization: 'x86-relocations-v1', digest: 'ccdd' },
				},
			}],
			unmatchedSource: oldFunctions,
			unmatchedTarget: newFunctions,
		});
	});

	test('keeps unmatched functions in their revision order', () => {
		const oldFunctions = [fn('0x1000', '0x1010'), fn('0x2000', '0x2010')];
		const newFunctions = [fn('0x5000', '0x5010'), fn('0x6000', '0x6010')];
		const result = matchFunctionRevisions(
			revision('old-image', [fingerprinted(oldFunctions[0], 'aa'), fingerprinted(oldFunctions[1], 'bb')]),
			revision('new-image', [fingerprinted(newFunctions[0], 'cc'), fingerprinted(newFunctions[1], 'dd')]),
		);

		assert.deepStrictEqual(result, {
			matches: [],
			ambiguous: [],
			unmatchedSource: oldFunctions,
			unmatchedTarget: newFunctions,
		});
	});

	test('rejects incomplete fingerprint provenance', () => {
		assert.throws(() => matchFunctionRevisions(
			revision('old-image', [{
				function: fn('0x1000', '0x1010'),
				fingerprint: { algorithm: 'sha256', normalization: '', digest: 'aa' },
			}]),
			revision('new-image', []),
		), /requires an algorithm, normalization profile, and digest/);
	});
});
