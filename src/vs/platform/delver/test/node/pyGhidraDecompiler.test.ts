/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DecompilerWorkerHost, IDecompilerWorkerHello } from '../../node/decompilerWorkerHost.js';
import { resolvePyGhidraWorkerScriptPath } from '../../node/pyGhidraDecompiler.js';
import { getDevGhidraScriptsDir, getStagedGhidraScriptsDir } from '../../node/delverBinaries.js';
import { createPyGhidraWorkerInvocation, discoverPyGhidraWorker, PyGhidraDecompiler, pyGhidraProjectDirectory, readBackendFunctions, resolvePythonPath } from '../../node/pyGhidraDecompiler.js';

const EMPTY_SEMANTICS = { schemaVersion: 2 as const, composites: [], dataTypes: [], functionPrototypes: [] };

suite('PyGhidraDecompiler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a backend function set, keeping an absent end absent', () => {
		assert.deepStrictEqual(
			readBackendFunctions({
				functions: [
					{ rva: '0xe2a0', endRva: '0x10dc0', name: 'SUB_E2A0' },
					{ rva: '0x1d7a0', endRva: null, name: 'thunk' },
				],
			}),
			[
				{ rva: '0xe2a0', endRva: '0x10dc0', name: 'SUB_E2A0' },
				{ rva: '0x1d7a0', endRva: undefined, name: 'thunk' },
			]
		);
	});

	test('a malformed function set is refused rather than silently shortened', () => {
		// A short list reads downstream as the backend having recovered less,
		// which is a claim about the backend the decoder may not make for it.
		const refusals = [
			() => readBackendFunctions({}),
			() => readBackendFunctions({ functions: [{ rva: 57248, name: 'n' }] }),
			() => readBackendFunctions({ functions: [{ rva: '0xE2A0', name: 'n' }] }),
			() => readBackendFunctions({ functions: [{ rva: '0xe2a0', endRva: '12345', name: 'n' }] }),
			() => readBackendFunctions({ functions: [{ rva: '0xe2a0' }] }),
			() => readBackendFunctions({ functions: [null] }),
		];
		assert.deepStrictEqual(refusals.map(run => { try { run(); return 'accepted'; } catch { return 'refused'; } }),
			['refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
	});

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
		let receivedSemantics: object | undefined;
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
			override async request(method: string, params: object): Promise<object> {
				requests.push(method);
				if (method === 'openTarget') {
					await openGate;
					return { targetId: 'session-1' };
				}
				receivedSemantics = (params as { semantics?: object }).semantics;
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
		const semantics = { schemaVersion: 2 as const, composites: [], dataTypes: [{ rva: '0x2000', declaration: 'uint32_t' }], functionPrototypes: [] };
		const result = await decompiler.decompileFunction('session-1', 'sample.exe', 'a'.repeat(64), '0x1000', semantics, CancellationToken.None);

		assert.deepStrictEqual({ requests, receivedSemantics, targetOpenMs: result.targetOpenMs, serialized: JSON.parse(result.serialized) }, {
			requests: ['openTarget', 'decompileFunction'],
			receivedSemantics: semantics,
			targetOpenMs: 0,
			serialized: { schemaVersion: 1, functionRva: '0x1000', text: 'return 0;', lineMappings: [], variables: [] },
		});
		decompiler.dispose();
	});

	test('shares one cached Ghidra project between sessions for identical content', async () => {
		const requests: { readonly method: string; readonly targetId: string | undefined }[] = [];
		let releaseOpen!: () => void;
		const openGate = new Promise<void>(resolve => { releaseOpen = resolve; });
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
			override async request(method: string, params: object): Promise<object> {
				requests.push({ method, targetId: (params as { targetId?: string }).targetId });
				if (method === 'openTarget') {
					await openGate;
				}
				return method === 'decompileFunction'
					? {
						schemaVersion: 1, functionRva: '0x1000', text: 'return 0;', lineMappings: [], variables: [],
						timings: { functionRecoveryMs: 1, decompilationMs: 2, serializationMs: 3 },
					}
					: { targetId: (params as { targetId?: string }).targetId };
			}
		}

		const worker = new FakeWorker();
		const decompiler = new PyGhidraDecompiler(
			{ ghidraHome: 'C:\\ghidra', pythonPath: 'python', workerScriptPath: 'worker.py' },
			'C:\\cache',
			worker,
		);
		const contentHash = 'a'.repeat(64);
		const first = decompiler.prepareTarget('session-1', 'sample.exe', contentHash);
		const second = decompiler.prepareTarget('session-2', 'copy.exe', contentHash);
		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(requests, [{ method: 'openTarget', targetId: 'session-1' }]);
		releaseOpen();
		await Promise.all([first, second]);
		await decompiler.decompileFunction('session-2', 'copy.exe', contentHash, '0x1000', EMPTY_SEMANTICS, CancellationToken.None);
		await decompiler.closeTarget('session-1');
		await decompiler.closeTarget('session-2');

		assert.deepStrictEqual(requests, [
			{ method: 'openTarget', targetId: 'session-1' },
			{ method: 'decompileFunction', targetId: 'session-1' },
			{ method: 'closeTarget', targetId: 'session-1' },
		]);
		decompiler.dispose();
	});

	test('repairs an unreadable cached Ghidra project and retries once', async () => {
		const cacheRoot = await fs.mkdtemp(join(tmpdir(), 'delver-pyghidra-test-'));
		const contentHash = 'b'.repeat(64);
		const projectDirectory = pyGhidraProjectDirectory(cacheRoot, '12.1', contentHash);
		const marker = join(projectDirectory, 'damaged-project');
		await fs.mkdir(projectDirectory, { recursive: true });
		await fs.writeFile(marker, 'damaged');
		let openAttempts = 0;
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
				if (method === 'openTarget' && openAttempts++ === 0) {
					throw new Error('backend_error: Could not open target with PyGhidra: java.io.IOException: Unrecognized file format');
				}
				return {};
			}
		}
		const decompiler = new PyGhidraDecompiler(
			{ ghidraHome: 'C:\\ghidra', pythonPath: 'python', workerScriptPath: 'worker.py' },
			cacheRoot,
			new FakeWorker(),
		);

		try {
			await decompiler.prepareTarget('session-1', 'sample.exe', contentHash);
			let damagedProjectExists = true;
			try {
				await fs.access(marker);
			} catch {
				damagedProjectExists = false;
			}
			assert.deepStrictEqual({ openAttempts, damagedProjectExists }, { openAttempts: 2, damagedProjectExists: false });
		} finally {
			decompiler.dispose();
			await fs.rm(cacheRoot, { recursive: true, force: true });
		}
	});

	test('resolves the worker script from the checkout, falling back to the staged copy', () => {
		const resolved = resolvePyGhidraWorkerScriptPath();
		assert.deepStrictEqual(
			[
				resolved === join(getDevGhidraScriptsDir(), 'delver_decompiler_worker.py') ||
				resolved === join(getStagedGhidraScriptsDir(), 'delver_decompiler_worker.py'),
				getStagedGhidraScriptsDir().split(/[\\/]/).slice(-3),
			],
			[true, ['resources', 'delver', 'ghidra']],
		);
	});
});
