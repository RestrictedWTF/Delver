/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawn } from 'child_process';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { mkdtempSync, promises, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { DelverAnalysisSession, waitForListening } from '../../node/analysisSession.js';
import { buildMinimalPe } from './minimalPe.js';

suite('DelverAnalysisSession', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let path: string;

	/**
	 * A generated PE keeps the test hermetic and fast. Using the Node binary
	 * instead would analyse ~92 MB and 8.8 million instructions per test.
	 */
	setup(() => {
		dir = mkdtempSync(join(tmpdir(), 'delver-test-'));
		path = join(dir, 'minimal.exe');
		writeFileSync(path, buildMinimalPe());
	});

	teardown(async () => {
		// Child-process shutdown is asynchronous. Windows may briefly retain the
		// sample handle after `dispose`, so use the asynchronous remover: its
		// retries yield to the shutdown promise instead of blocking the event loop.
		await promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	test('starts a provider and analysis server and serves listing rows', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			assert.ok(
				session.image.instruction_count > 0,
				'a real PE must decode to at least one instruction'
			);

			const window = await session.listingWindow(0, 4);
			assert.strictEqual(window.rows.length, 3, 'the generated PE decodes to three instructions');
			assert.strictEqual(
				window.rows[0].row,
				0,
				'the first requested row must be row zero'
			);
			assert.ok(window.rows[0].mnemonic.length > 0, 'rows carry formatted text');
			assert.ok(
				window.total_rows >= BigInt(window.rows.length) ||
				Number(window.total_rows) >= window.rows.length,
				'total row count is reported so a client can size a scrollbar'
			);
		} finally {
			session.dispose();
		}
	});

	test('round-trips between rows and addresses', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			const address = await session.addressForRow(0);
			assert.ok(address !== undefined, 'row zero has an address');

			const row = await session.rowForAddress(address!, false);
			assert.strictEqual(row, 0, 'an exact instruction boundary maps back to its row');
		} finally {
			session.dispose();
		}
	});

	test('serves image headers alongside analysis, from one session', async function () {
		this.timeout(30_000);

		// One open has to populate everything. Headers come from the provider on
		// a second client rather than through the analysis server, so this also
		// covers a provider serving two clients at once (P1 decision E1).
		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			const [info, window] = await Promise.all([
				session.getImageInfo(),
				session.listingWindow(0, 1),
			]);
			assert.match(info.content_hash, /^[0-9a-f]{64}$/);

			assert.deepStrictEqual(
				{
					arch: info.arch,
					sections: info.sections.map(s => s.name),
					rows: window.rows.length,
				},
				{
					arch: 'X86_64',
					sections: ['.text'],
					rows: 1,
				},
			);
		} finally {
			session.dispose();
		}
	});

	test('serves imports grouped by module', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			const { modules } = await session.getImports();
			// The generated PE has no import directory. An empty list is the
			// correct answer and must not be an error — plenty of real images,
			// including shellcode-style payloads, import nothing statically.
			assert.deepStrictEqual(modules, []);
		} finally {
			session.dispose();
		}
	});

	test('reports functions with their confidence', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			const { functions } = await session.functions();
			assert.ok(functions.length > 0, 'a real PE yields functions');
			assert.ok(
				functions.some(f => f.authoritative),
				'at least one boundary must come from a source the image vouches for'
			);
		} finally {
			session.dispose();
		}
	});

	test('serves verified image and file bytes from provider frames', async function () {
		this.timeout(30_000);

		const session = await DelverAnalysisSession.start({ kind: 'file', path });
		try {
			const [image, file] = await Promise.all([
				session.readMemory('Image', 0x1000n, 8),
				session.readMemory('File', 0n, 2),
			]);
			assert.deepStrictEqual({ image, file }, {
				image: {
					bytesHex: '4889d84883c001c3',
					valid: [{ start: '0x1000', end: '0x1008' }],
					servedMoment: { kind: 'static', epoch: 0 },
				},
				file: {
					bytesHex: '4d5a',
					valid: [{ start: '0x0', end: '0x2' }],
					servedMoment: { kind: 'static', epoch: 0 },
				},
			});
		} finally {
			session.dispose();
		}
	});

	test('reports a missing provider immediately instead of as a listening timeout', async () => {
		const missing = spawn(`delver-provider-that-does-not-exist-${process.pid}`);
		await assert.rejects(
			waitForListening(missing, 'provider-file', 10_000),
			/error|ENOENT|failed to start/i,
		);
	});
});
