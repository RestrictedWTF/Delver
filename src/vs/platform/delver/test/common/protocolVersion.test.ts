/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DELVER_PROTOCOL_VERSION } from '../../common/protocol.generated.js';
import { readInitializeResult } from '../../common/protocolVersion.js';

suite('Delver protocol version', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function refusal(result: unknown): string | undefined {
		try {
			readInitializeResult(result, 'provider-file');
			return undefined;
		} catch (e) {
			return (e as Error).message;
		}
	}

	const handshake = (version: unknown) => ({
		protocol_version: version,
		capabilities: [],
		spaces: [],
		target: { name: 'file', kind: 'file' },
	});

	test('a provider speaking this build\'s version is accepted', () => {
		const result = handshake(DELVER_PROTOCOL_VERSION);
		assert.strictEqual(readInitializeResult(result, 'provider-file'), result);
	});

	test('anything but this build\'s version is refused, and says what to do', () => {
		// A stale binary, a version that is not a version, and a handshake with
		// no version at all. The last two fail closed: a process that cannot say
		// what it speaks is not one to keep talking to.
		assert.deepStrictEqual(
			[
				refusal(handshake('0')),
				refusal(handshake(1)),
				refusal(handshake(undefined)),
				refusal(undefined),
			],
			[
				'Delver protocol version mismatch: provider-file reported "0", this build speaks "1". Rebuild or update provider-file.',
				'Delver protocol version mismatch: provider-file reported no version at all, this build speaks "1". Rebuild or update provider-file.',
				'Delver protocol version mismatch: provider-file reported no version at all, this build speaks "1". Rebuild or update provider-file.',
				'Delver protocol version mismatch: provider-file reported no version at all, this build speaks "1". Rebuild or update provider-file.',
			]
		);
	});
});
