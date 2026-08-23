/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { IDelverAnalysisService } from '../../../../../platform/delver/common/delverAnalysisService.js';
import { IDelverProjectSnapshot } from '../../../../../platform/delver/common/delverProjectStoreService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	decompilerLinesForRva,
	DelverDecompilerService,
	DelverDecompilerUnavailableError,
	IDecompiledFunction,
	IDecompileFunctionRequest,
	IDelverDecompilerBackend,
	IDelverDecompilerService,
	rangesForDecompilerLine,
	SharedProcessDecompilerBackend,
} from '../../common/delverDecompilerService.js';

const request: IDecompileFunctionRequest = {
	sessionId: 'session-1',
	targetPath: 'sample.exe',
	contentHash: 'a'.repeat(64),
	functionRva: 0x1000n,
};

const result: IDecompiledFunction = {
	backendId: 'test',
	functionRva: 0x1000n,
	text: 'int entry(void) {\n\treturn 0;\n}',
	lineMappings: [
		{ line: 2, ranges: [{ startRva: 0x1000n, endRva: 0x1004n }, { startRva: 0x1010n, endRva: 0x1012n }] },
		{ line: 2, ranges: [{ startRva: 0x1020n, endRva: 0x1021n }] },
		{ line: 4, ranges: [{ startRva: 0x1002n, endRva: 0x1006n }] },
	],
	variables: [{ name: 'result', typeName: 'int', storage: 'EAX', declarationLine: 1 }],
};

function serializedResult(functionRva: bigint, text: string): string {
	return JSON.stringify({ schemaVersion: 1, functionRva: `0x${functionRva.toString(16)}`, text, lineMappings: [], variables: [] });
}

function snapshot(decompiledFunctions: IDelverProjectSnapshot['decompiledFunctions'], functions = ['0x1000', '0x2000']): IDelverProjectSnapshot {
	return {
		metadata: {
			contentHash: request.contentHash,
			displayName: 'sample.exe',
			schemaVersion: 5,
			currentRevisionId: request.contentHash,
			createdAt: 1,
			updatedAt: 2,
		},
		functions: JSON.stringify({ functions: functions.map(rva => ({ rva })) }),
		decompiledFunctions,
		interpretations: [],
		findings: [],
		findingDecisions: [],
		toolCalls: [],
	};
}

suite('DelverDecompilerService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered as a singleton', () => {
		assert.ok(getSingletonServiceDescriptors().some(([id]) => id === IDelverDecompilerService));
	});

	test('reports the scaffold backend as unavailable', async () => {
		const backend: IDelverDecompilerBackend = {
			status: { state: 'unconfigured', available: false, reason: 'No backend' },
			async decompileFunction() {
				throw new DelverDecompilerUnavailableError('No backend');
			},
		};
		const service = new DelverDecompilerService(backend);
		assert.strictEqual(service.status.available, false);
		await assert.rejects(service.decompileFunction(request, CancellationToken.None), DelverDecompilerUnavailableError);
	});

	test('forwards requests and cancellation tokens to the selected backend', async () => {
		let received: { request: IDecompileFunctionRequest; token: CancellationToken } | undefined;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction(backendRequest, token) {
				received = { request: backendRequest, token };
				return result;
			},
		};
		const service = new DelverDecompilerService(backend);

		assert.strictEqual(await service.decompileFunction(request, CancellationToken.None), result);
		assert.deepStrictEqual(received, { request, token: CancellationToken.None });
	});

	test('reuses a completed result for the same image and function', async () => {
		let invocations = 0;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction() {
				invocations++;
				return result;
			},
		};
		const service = new DelverDecompilerService(backend);

		assert.strictEqual(await service.decompileFunction(request, CancellationToken.None), result);
		assert.strictEqual(await service.decompileFunction({
			...request,
			sessionId: 'reopened-session',
			targetPath: 'moved-sample.exe',
		}, CancellationToken.None), result);
		assert.strictEqual(invocations, 1);
	});

	test('does not reuse pseudocode for a different function', async () => {
		let invocations = 0;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction(backendRequest) {
				invocations++;
				return { ...result, functionRva: backendRequest.functionRva };
			},
		};
		const service = new DelverDecompilerService(backend);

		await service.decompileFunction(request, CancellationToken.None);
		await service.decompileFunction({ ...request, functionRva: 0x2000n }, CancellationToken.None);
		assert.strictEqual(invocations, 2);
	});

	test('does not invoke a backend after cancellation', () => {
		let invoked = false;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction() {
				invoked = true;
				return result;
			},
		};
		const source = new CancellationTokenSource();
		source.cancel();

		assert.throws(
			() => new DelverDecompilerService(backend).decompileFunction(request, source.token),
			error => isCancellationError(error),
		);
		assert.strictEqual(invoked, false);
		source.dispose();
	});

	test('loads an exact saved result without consulting an unavailable backend', async () => {
		let invocations = 0;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'disabled', available: false, reason: 'Ghidra is disabled' },
			async decompileFunction() {
				invocations++;
				throw new Error('must not run');
			},
		};
		const saved = snapshot([{
			backendId: 'ghidra-headless',
			backendVersion: '12.1',
			functionRva: '0x1000',
			serialized: serializedResult(0x1000n, 'saved entry'),
		}]);
		const service = new DelverDecompilerService(backend, contentHash => contentHash === request.contentHash ? saved : undefined);

		assert.deepStrictEqual(await service.decompileFunction({ ...request, sessionId: undefined, targetPath: undefined }, CancellationToken.None), {
			backendId: 'ghidra-headless',
			backendVersion: '12.1',
			provenance: 'saved',
			functionRva: 0x1000n,
			text: 'saved entry',
			lineMappings: [],
			variables: [],
		});
		assert.strictEqual(invocations, 0);
	});

	test('keeps different saved RVAs isolated', async () => {
		const backend: IDelverDecompilerBackend = {
			status: { state: 'disabled', available: false, reason: 'offline' },
			async decompileFunction() { throw new Error('must not run'); },
		};
		const saved = snapshot([
			{ backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000', serialized: serializedResult(0x1000n, 'first') },
			{ backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x2000', serialized: serializedResult(0x2000n, 'second') },
		]);
		const service = new DelverDecompilerService(backend, () => saved);

		assert.deepStrictEqual([
			(await service.decompileFunction(request, CancellationToken.None)).text,
			(await service.decompileFunction({ ...request, functionRva: 0x2000n }, CancellationToken.None)).text,
		], ['first', 'second']);
	});

	test('rejects malformed and stale saved rows instead of displaying another function', async () => {
		let invocations = 0;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction(backendRequest) {
				invocations++;
				return { ...result, functionRva: backendRequest.functionRva, text: 'live' };
			},
		};
		const malformed = snapshot([{
			backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000',
			serialized: serializedResult(0x2000n, 'wrong function'),
		}]);
		const service = new DelverDecompilerService(backend, () => malformed);

		assert.deepStrictEqual({
			text: (await service.decompileFunction(request, CancellationToken.None)).text,
			diagnostic: service.savedResultDiagnostic(request)?.includes('does not match'),
			invocations,
		}, { text: 'live', diagnostic: true, invocations: 1 });

		const staleService = new DelverDecompilerService(backend, () => snapshot(malformed.decompiledFunctions, ['0x2000']));
		await staleService.decompileFunction(request, CancellationToken.None);
		assert.strictEqual(staleService.savedResultDiagnostic(request)?.includes('not present'), true);
	});

	test('coalesces concurrent backend requests for one exact key', async () => {
		let invocations = 0;
		let complete!: (value: IDecompiledFunction) => void;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			decompileFunction: async () => {
				invocations++;
				return new Promise<IDecompiledFunction>(resolve => complete = resolve);
			},
		};
		const service = new DelverDecompilerService(backend);
		const first = service.decompileFunction(request, CancellationToken.None);
		const second = service.decompileFunction(request, CancellationToken.None);
		complete(result);

		assert.deepStrictEqual({ results: await Promise.all([first, second]), invocations }, {
			results: [result, result],
			invocations: 1,
		});
	});

	test('keeps a saved result when explicit re-decompilation is cancelled', async () => {
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction() { throw new CancellationError(); },
		};
		const saved = snapshot([{
			backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000',
			serialized: serializedResult(0x1000n, 'saved before refresh'),
		}]);
		const service = new DelverDecompilerService(backend, () => saved);
		await service.decompileFunction(request, CancellationToken.None);

		await assert.rejects(service.redecompileFunction(request, CancellationToken.None), error => isCancellationError(error));
		assert.strictEqual((await service.decompileFunction(request, CancellationToken.None)).text, 'saved before refresh');
	});

	test('maps lines and RVAs across discontiguous and overlapping ranges', () => {
		assert.deepStrictEqual(
			{
				line2: rangesForDecompilerLine(result, 2),
				line3: rangesForDecompilerLine(result, 3),
				rva1002: decompilerLinesForRva(result, 0x1002n),
				rva1011: decompilerLinesForRva(result, 0x1011n),
				rva1021: decompilerLinesForRva(result, 0x1021n),
			},
			{
				line2: [
					{ startRva: 0x1000n, endRva: 0x1004n },
					{ startRva: 0x1010n, endRva: 0x1012n },
					{ startRva: 0x1020n, endRva: 0x1021n },
				],
				line3: [],
				rva1002: [2, 4],
				rva1011: [2],
				rva1021: [],
			},
		);
	});

	test('bridges configured requests through the shared process', async () => {
		let received: readonly string[] | undefined;
		const analysisService: Partial<IDelverAnalysisService> = {
			async decompilerStatus() {
				return { state: 'ready', backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 1, spawnMs: 2, handshakeMs: 3 };
			},
			async decompileFunction(sessionId, rva, contentHash, ghidraHome, pythonPath, operationId) {
				received = [sessionId, rva, contentHash, ghidraHome, pythonPath, operationId];
				return {
					backendId: 'ghidra-pyghidra',
					backendVersion: '12.1',
					adapterVersion: '1',
					processGeneration: 1,
					timings: { spawnMs: 2, handshakeMs: 3, targetOpenMs: 4, functionRecoveryMs: 5, decompilationMs: 6, serializationMs: 7 },
					serialized: JSON.stringify({ schemaVersion: 1, functionRva: '0x1000', text: 'void entry(void) {}', lineMappings: [], variables: [] }),
				};
			},
			async cancelDecompile() { },
		};
		const configurationService: Partial<IConfigurationService> = {
			getValue: <T>(key?: string | object) => (key === 'delver.decompiler.ghidraHome' ? ' C:\\ghidra ' : ' C:\\Python\\python.exe ') as T,
		};
		const backend = new SharedProcessDecompilerBackend(
			analysisService as IDelverAnalysisService,
			configurationService as IConfigurationService,
		);

		assert.deepStrictEqual({
			result: await backend.decompileFunction(request, CancellationToken.None),
			received: received?.slice(0, 5),
			operationIdLength: received?.[5].length,
		}, {
			result: {
				backendId: 'ghidra-pyghidra',
				backendVersion: '12.1',
				adapterVersion: '1',
				processGeneration: 1,
				timings: { spawnMs: 2, handshakeMs: 3, targetOpenMs: 4, functionRecoveryMs: 5, decompilationMs: 6, serializationMs: 7 },
				provenance: 'live',
				functionRva: 0x1000n,
				text: 'void entry(void) {}',
				lineMappings: [],
				variables: [],
			},
			received: ['session-1', '0x1000', 'a'.repeat(64), 'C:\\ghidra', 'C:\\Python\\python.exe'],
			operationIdLength: 36,
		});
	});

	test('restarts the configured persistent backend explicitly', async () => {
		const calls: string[][] = [];
		const analysisService: Partial<IDelverAnalysisService> = {
			async restartDecompiler(ghidraHome, pythonPath, backend) {
				calls.push([ghidraHome ?? '', pythonPath ?? '', backend ?? '']);
				return { state: 'ready', backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 2, spawnMs: 3, handshakeMs: 4 };
			},
		};
		const configurationService: Partial<IConfigurationService> = {
			getValue: <T>(key?: string | object) => (key === 'delver.decompiler.ghidraHome' ? 'C:\\ghidra' : key === 'delver.decompiler.backend' ? 'pyghidra' : 'C:\\Python\\python.exe') as T,
		};
		const backend = new SharedProcessDecompilerBackend(
			analysisService as IDelverAnalysisService,
			configurationService as IConfigurationService,
		);

		assert.deepStrictEqual({ status: await backend.restart(), calls }, {
			status: { state: 'ready', available: true, backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 2, spawnMs: 3, handshakeMs: 4 },
			calls: [['C:\\ghidra', 'C:\\Python\\python.exe', 'pyghidra']],
		});
	});

	test('reports cache inventory and retains the latest live phase timings', async () => {
		const cacheInfo = { path: 'C:\\cache', projectCount: 2, fileCount: 8, byteLength: 4096 };
		const timedResult: IDecompiledFunction = {
			...result,
			provenance: 'live',
			timings: { spawnMs: 1, handshakeMs: 2, targetOpenMs: 3, functionRecoveryMs: 4, decompilationMs: 5, serializationMs: 6 },
		};
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async cacheInfo() { return cacheInfo; },
			async clearCache() { return cacheInfo; },
			async decompileFunction() { return timedResult; },
		};
		const service = new DelverDecompilerService(backend);

		assert.deepStrictEqual({
			before: service.latestPerformance,
			inventory: await service.cacheInfo(),
			removed: await service.clearCache(),
			result: await service.decompileFunction(request, CancellationToken.None),
			after: service.latestPerformance,
		}, {
			before: undefined,
			inventory: cacheInfo,
			removed: cacheInfo,
			result: timedResult,
			after: timedResult,
		});
	});

	test('prepares a live target through PyGhidra before the first function request', async () => {
		const calls: string[][] = [];
		const analysisService: Partial<IDelverAnalysisService> = {
			async decompilerStatus() {
				return { state: 'ready', backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 1, spawnMs: 2, handshakeMs: 3 };
			},
			async prepareDecompilerTarget(sessionId, contentHash, ghidraHome, pythonPath) {
				calls.push([sessionId, contentHash, ghidraHome, pythonPath]);
				return { backendId: 'ghidra-pyghidra', backendVersion: '12.1', processGeneration: 1, spawnMs: 2, handshakeMs: 3, targetOpenMs: 4 };
			},
		};
		const configurationService: Partial<IConfigurationService> = {
			getValue: <T>(key?: string | object) => (key === 'delver.decompiler.ghidraHome' ? 'C:\\ghidra' : key === 'delver.decompiler.backend' ? 'pyghidra' : 'C:\\Python\\python.exe') as T,
		};
		const backend = new SharedProcessDecompilerBackend(
			analysisService as IDelverAnalysisService,
			configurationService as IConfigurationService,
		);

		await backend.prepareTarget?.({ sessionId: 'session-1', targetPath: 'sample.exe', contentHash: 'a'.repeat(64) });
		assert.deepStrictEqual(calls, [['session-1', 'a'.repeat(64), 'C:\\ghidra', 'C:\\Python\\python.exe']]);
	});
});
