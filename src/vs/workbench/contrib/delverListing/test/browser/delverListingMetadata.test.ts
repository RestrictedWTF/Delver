/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGetImageInfoResult, ISectionWire } from '../../../../../platform/delver/common/protocol.generated.js';
import { listingAddressLabel, listingMetadata } from '../../browser/delverListingMetadata.js';

const textSection: ISectionWire = {
	name: '.text',
	virtual_address: '0x1000',
	virtual_size: 0x200,
	raw_offset: '0x400',
	raw_size: 0x200,
	readable: true,
	writable: false,
	executable: true,
	entropy: 6.1,
};

suite('DelverListingMetadata', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefixes an address with its owning section', () => {
		assert.deepStrictEqual(
			[listingAddressLabel('0x1000', [textSection]), listingAddressLabel('0x2000', [textSection])],
			['.text:0x1000', 'image:0x2000'],
		);
	});

	test('summarizes the available target and section metadata', () => {
		const info: IGetImageInfoResult = {
			arch: 'x86_64',
			content_hash: 'ab'.repeat(32),
			entry: '0x1010',
			export_count: 0,
			function_seed_count: 1,
			image_base: '0x140000000',
			import_module_count: 1,
			import_symbol_count: 2,
			relocation_count: 3,
			sections: [textSection],
		};

		assert.deepStrictEqual(listingMetadata('C:\\samples\\sample.exe', info).split('\n'), [
			`.text:0x1000 ; Input SHA256 : ${'AB'.repeat(32)}`,
			'.text:0x1000 ; File Name    : C:\\samples\\sample.exe',
			'.text:0x1000 ; Architecture : x86_64',
			'.text:0x1000 ; Image Base   : 0x140000000',
			'.text:0x1000 ; Entry Point  : 0x1010',
			'.text:0x1000 ; Section 1: .text | VA 0x1000 | virtual 512 bytes | raw 512 bytes at 0x400 | R-X',
		]);
	});
});
