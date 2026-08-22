/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DecompilerWorkerHost, IDecompilerWorkerHello } from '../../node/decompilerWorkerHost.js';
import { createPyGhidraWorkerInvocation, discoverPyGhidraWorker, PyGhidraDecompiler, pyGhidraProjectDirectory, resolvePythonPath } from '../../node/pyGhidraDecompiler.js';

suite('PyGhidraDecompiler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('discovers static prerequisites and builds a shell-free invocation', () => {
		const discovery = discoverPyGhidraWorker('C:\\ghidra', 'C:\\Python\\python.exe', 'D:\\Delver\\worker.py', () => true);
		assert.strictEqual(discovery.available, true);
		if (!discovery.available) {
			return;
		}
		const invocation = createPyGhidraWorkerInvocation(discovery.configuration);
		assert.deepStrictEqual({
			command: invocation.command,
			args: invocation.args,
			ghidraHome: invocation.options.env?.GHIDRA_INSTALL_DIR,
			stdio: invocation.options.stdio,
		}, {
			command: 'C:\\Python\\python.exe',
			args: ['D:\\Delver\\worker.py', '--ghidra-home', 'C:\\ghidra'],
			ghidraHome: 'C:\\ghidra',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	});

	test('requires the worker script but does not pretend to probe Python packages', () => {
		assert.deepStrictEqual(
			discoverPyGhidraWorker('C:\\ghidra', 'python', 'missing.py', () => false),
			{ available: false, reason: 'Delver\'s decompiler worker is missing: missing.py' },
		);
	});

	test('auto-selects a Windows Python installation that contains PyGhidra', () => {
		const existing = new Set([
			'C:\\Python313\\python.exe',
			'C:\\Python313\\Lib\\site-packages\\pyghidra',
			'C:\\Python314\\python.exe',
		]);
		assert.strictEqual(
			resolvePythonPath('auto', candidate => existing.has(candidate), 'win32', ['C:\\Python314', 'C:\\Python313']),
			'C:\\Python313\\python.exe',
		);
	});

	test('keys persistent projects by backend, analysis profile, and content hash', () => {
		const hash = 'A'.repeat(64);
		assert.strictEqual(
			pyGhidraProjectDirectory('C:\\cache', '12.1', hash),
			'C:\\cache\\ghidra-12.1\\analysis-v1\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		);
		assert.throws(() => pyGhidraProjectDirectory('C:\\cache', '12.1', '..'));
	});

	test('coalesces background preparation with the first decompilation', async () => {
		let releaseOpen!: () => void;
		const openGate = new Promise<void>(resolve => releaseOpen = resolve);
		const requests: string[] = [];
		class FakeWorker extends DecompilerWorkerHost {
			constructor() { super({ command: 'python', args: [], options: {} }); }
			override get generation(): number { return 1; }
			override start(): Promise<IDecompilerWorkerHello> {
				return Promise.resolve({
					protocolVersion: 1,
					backend: { id: 'ghidra-pyghidra', label: 'PyGhidra', version: '12.1' },
					capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
				});
			}
			override async request(method: string): Promise<object> {
				requests.push(method);
				if (method === 'openTarget') {
					await openGate;
					return { targetId: 'session-1' };
				}
				return {
					schemaVersion: 1, functionRva: '0x1000', text: 'return 0;', lineMappings: [], variables: [],
					timings: { functionRecoveryMs: 1, decompilationMs: 2, serializationMs: 3 },
				};
			}
		}
		const worker = new FakeWorker();
		const decompiler = new PyGhidraDecompiler(
			{ ghidraHome: 'C:\\ghidra', pythonPath: 'python', workerScriptPath: 'worker.py' },
			'C:\\cache',
			worker,
		);
		const first = decompiler.prepareTarget('session-1', 'sample.exe', 'a'.repeat(64));
		const second = decompiler.prepareTarget('session-1', 'sample.exe', 'a'.repeat(64));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(requests, ['openTarget']);
		releaseOpen();
		await Promise.all([first, second]);
		const result = await decompiler.decompileFunction('session-1', 'sample.exe', 'a'.repeat(64), '0x1000', CancellationToken.None);

		assert.deepStrictEqual({ requests, targetOpenMs: result.targetOpenMs, serialized: JSON.parse(result.serialized) }, {
			requests: ['openTarget', 'decompileFunction'],
			targetOpenMs: 0,
			serialized: { schemaVersion: 1, functionRva: '0x1000', text: 'return 0;', lineMappings: [], variables: [] },
		});
		decompiler.dispose();
	});
});
