/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { BufferWriter, serialize } from '../../../../base/parts/ipc/common/ipc.js';
import { DelverProviderProcess } from '../../node/providerProcess.js';
import { TargetCapability } from '../../common/capabilities.js';
import { buildMinimalPe } from './minimalPe.js';

suite('DelverProviderProcess', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let path: string;

	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'delver-test-'));
		path = join(dir, 'minimal.exe');
		writeFileSync(path, buildMinimalPe());
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('spawns provider-file and receives initialize', async function () {
		this.timeout(30_000);

		const target = await DelverProviderProcess.attach({ kind: 'file', path });
		try {
			assert.strictEqual(target.descriptor.kind, 'file');
			assert.ok(target.capabilities.includes(TargetCapability.ListSpaces));
			assert.ok(target.capabilities.includes(TargetCapability.GetImageInfo));
			assert.ok(target.capabilities.includes(TargetCapability.ReadMemory));

			const spaces = await target.listSpaces();
			assert.deepStrictEqual(
				spaces.map(s => s.id).sort(),
				['File', 'Image'],
				'a file target exposes exactly the file and image spaces'
			);
			assert.ok(
				spaces.every(s => typeof s.size === 'bigint'),
				'domain-side sizes are bigint, never the "0x..." string they arrived as'
			);
		} finally {
			target.dispose();
		}
	});

	test('concurrent calls each get their own response', async function () {
		this.timeout(30_000);

		// The transport is one ordered stream, so overlapping calls used to read
		// each other's replies — the caller of request 3 consuming response 2.
		// Any view that fetches while another is fetching hits this, so it is the
		// normal case rather than an edge one.
		const target = await DelverProviderProcess.attach({ kind: 'file', path });
		try {
			const [spaces, info, spacesAgain] = await Promise.all([
				target.listSpaces(),
				target.getImageInfo(),
				target.listSpaces(),
			]);

			assert.deepStrictEqual(
				spaces.map(s => s.id).sort(),
				['File', 'Image'],
				'listSpaces must not receive the getImageInfo reply'
			);
			assert.deepStrictEqual(spacesAgain.map(s => s.id).sort(), ['File', 'Image']);
			assert.ok(info.sections.length > 0, 'getImageInfo must not receive a listSpaces reply');
		} finally {
			target.dispose();
		}
	});

	test('the snapshot survives IPC serialization', async function () {
		this.timeout(30_000);

		// The snapshot crosses the shared-process boundary, where VS Code
		// serializes object payloads with `JSON.stringify` — which throws on
		// `bigint`. That throw happens inside the channel server's promise
		// callback, so no response is ever sent and the renderer's `attach()`
		// never settles: no error, no timeout, just a target that never appears.
		// Serializing here is the only cheap way to catch a bigint creeping back
		// into this type, because nothing about it fails to compile.
		const target = await DelverProviderProcess.attach({ kind: 'file', path });
		const writer = new BufferWriter();
		try {
			assert.doesNotThrow(() => serialize(writer, target.snapshot));
		} finally {
			writer.dispose();
			target.dispose();
		}
	});
});
