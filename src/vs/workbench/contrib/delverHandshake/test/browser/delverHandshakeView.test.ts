/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { handshake } from '../../../../services/delver/common/delverFunctionHandshake.js';
import { ITreeItem } from '../../../../common/views.js';
import { DelverHandshakeTreeDataProvider, handshakeRvaFromHandle } from '../../browser/delverHandshakeView.js';

function delverFn(rva: string, endRva: string | undefined, source = FunctionSourceWire.ExceptionDirectory): IFunctionWire {
	return { rva, end_rva: endRva, source, authoritative: true };
}

function backendFn(rva: string, endRva: string | undefined, name = 'FUN') {
	return { rva, endRva, name };
}

function provider(delver: readonly IFunctionWire[], backend: readonly { rva: string; endRva: string | undefined; name: string }[]) {
	const instance = new DelverHandshakeTreeDataProvider();
	instance.setResult(handshake(delver, { backendId: 'ida-idalib', backendVersion: '9.1', analysisComplete: true, functions: backend }));
	return instance;
}

function labels(items: readonly ITreeItem[] | undefined): (readonly [string, string | undefined])[] {
	return (items ?? []).map(item => {
		const label = item.label?.label;
		return [
			typeof label === 'string' ? label : '',
			typeof item.description === 'string' ? item.description : undefined,
		] as const;
	});
}

suite('Delver handshake view', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('root items name the counts without claiming who is right', async () => {
		const instance = provider(
			[delverFn('0x1000', '0x1200'), delverFn('0x1100', '0x1200'), delverFn('0x9000', '0x9010')],
			[backendFn('0x1000', '0x1200'), backendFn('0x5000', '0x5010')],
		);

		assert.deepStrictEqual(labels(await instance.getChildren()), [
			['1 of 3 functions agree', 'vs ida-idalib (2 functions)'],
			['Only Delver found these', '1'],
			['Only the backend found these', '1'],
			['Split differently', '1'],
		]);
	});

	test('a kind with no rows is absent rather than shown as zero', async () => {
		const instance = provider([delverFn('0x1000', '0x1100')], [backendFn('0x1000', '0x1100')]);

		assert.deepStrictEqual(labels(await instance.getChildren()), [
			['1 of 1 functions agree', 'vs ida-idalib (1 functions)'],
		]);
	});

	test('a concentrated disagreement names its source where the count is', async () => {
		const delver = [delverFn('0x1000', '0x9000')];
		for (let index = 0; index < 12; index++) {
			const start = 0x2000 + index * 0x100;
			delver.push(delverFn(`0x${start.toString(16)}`, `0x${(start + 0x80).toString(16)}`));
		}
		const instance = provider(delver, [backendFn('0x1000', '0x9000')]);

		const root = await instance.getChildren();
		const split = labels(root).find(([label]) => label === 'Split differently');
		assert.deepStrictEqual(split, ['Split differently', '12 — mostly exception directory']);
	});

	test('expanding a group yields navigable rows that say what each side claims', async () => {
		const instance = provider(
			[delverFn('0x9000', '0x9010', FunctionSourceWire.LinearSweep)],
			[backendFn('0x5000', '0x5010', 'FUN_5000')],
		);

		const root = await instance.getChildren();
		const delverOnly = (root ?? []).find(item => item.label?.label === 'Only Delver found these');
		const backendOnly = (root ?? []).find(item => item.label?.label === 'Only the backend found these');

		assert.deepStrictEqual(
			[labels(await instance.getChildren(delverOnly)), labels(await instance.getChildren(backendOnly))],
			[
				[['SUB_9000', 'Delver: guess']],
				[['SUB_5000', 'backend only: FUN_5000']],
			],
		);
	});

	test('a row handle round-trips to the address it names', async () => {
		const instance = provider([delverFn('0x9000', '0x9010')], []);
		const root = await instance.getChildren();
		const rows = await instance.getChildren((root ?? [])[1]);

		assert.deepStrictEqual(
			[handshakeRvaFromHandle((rows ?? [])[0].handle), handshakeRvaFromHandle('delver.handshake.group.boundaryDispute')],
			[0x9000n, undefined],
		);
	});

	test('clearing the result empties the tree rather than leaving stale addresses', async () => {
		const instance = provider([delverFn('0x9000', '0x9010')], []);
		instance.setResult(undefined);

		assert.deepStrictEqual(await instance.getChildren(), []);
	});
});
