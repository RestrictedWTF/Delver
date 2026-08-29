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
import { IDelverProjectService } from '../../common/delverProjectService.js';
import { Anchor, anchorKey, EditOp, EditStatus, IEdit, IInterpretationAt } from '../../../../../platform/delver/common/interpretation.js';
import { IDelverInterpretationService } from '../../common/delverInterpretationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	decompilerLinesForRva,
	DELVER_DECOMPILER_BACKEND_SETTING,
	DelverDecompilerService,
	DelverDecompilerUnavailableError,
	semanticDependenciesFor,
	IDecompilationSemanticDependencies,
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

function serializedResult(functionRva: bigint, text: string, semanticDependencies?: IDecompilationSemanticDependencies): string {
	return JSON.stringify({
		schemaVersion: 1,
		functionRva: `0x${functionRva.toString(16)}`,
		text,
		lineMappings: [],
		variables: [],
		...(semanticDependencies ? { semanticDependencies } : {}),
	});
}

const typedDependencies: IDecompilationSemanticDependencies = {
	schemaVersion: 2,
	composites: [],
	dataTypes: [{ rva: '0x3000', declaration: 'uint32_t' }],
	functionPrototypes: [{ rva: '0x1000', declaration: 'int entry(uint32_t flags)' }],
};

function snapshot(decompiledFunctions: IDelverProjectSnapshot['decompiledFunctions'], functions = ['0x1000', '0x2000']): IDelverProjectSnapshot {
	return {
		metadata: {
			contentHash: request.contentHash,
			displayName: 'sample.exe',
			schemaVersion: 6,
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
		signatures: [],
	};
}

/** The two methods the snapshot builder reads, and nothing else. */
class FakeSemanticInterpretation implements Partial<IDelverInterpretationService> {
	constructor(private readonly edits: readonly { anchor: Anchor; op: EditOp; value: string }[]) { }

	logFor(): readonly IEdit[] {
		return this.edits.map((edit, index) => ({
			seq: index + 1,
			at: 0,
			author: { kind: 'human', id: 'analyst' },
			anchor: edit.anchor,
			op: edit.op,
			value: edit.value,
			status: EditStatus.Accepted,
		}));
	}

	at(anchor: Anchor): IInterpretationAt | undefined {
		const match = this.edits.find(edit => anchorKey(edit.anchor) === anchorKey(anchor));
		if (!match) {
			return undefined;
		}
		return match.op === EditOp.CompositeType
			? { compositeType: match.value }
			: match.op === EditOp.DataType ? { dataType: match.value } : { functionPrototype: match.value };
	}
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
		assert.deepStrictEqual(received, {
			request: { ...request, semanticDependencies: { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] } },
			token: CancellationToken.None,
		});
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

	test('rejects saved pseudocode produced against a different accepted type model', async () => {
		let invocations = 0;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction() {
				invocations++;
				return { ...result, text: 'typed live result' };
			},
		};
		const saved = snapshot([{
			backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000',
			serialized: serializedResult(0x1000n, 'untyped saved result'),
		}]);
		const service = new DelverDecompilerService(backend, () => saved, () => typedDependencies);

		assert.deepStrictEqual({
			text: (await service.decompileFunction(request, CancellationToken.None)).text,
			diagnostic: service.savedResultDiagnostic(request)?.includes('accepted type interpretation changed'),
			invocations,
		}, { text: 'typed live result', diagnostic: true, invocations: 1 });
	});

	test('loads saved pseudocode carrying the exact accepted semantic snapshot', async () => {
		const backend: IDelverDecompilerBackend = {
			status: { state: 'disabled', available: false, reason: 'offline' },
			async decompileFunction() { throw new Error('must not run'); },
		};
		const saved = snapshot([{
			backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000',
			serialized: serializedResult(0x1000n, 'typed saved result', typedDependencies),
		}]);
		const service = new DelverDecompilerService(backend, () => saved, () => typedDependencies);

		assert.deepStrictEqual({
			text: (await service.decompileFunction(request, CancellationToken.None)).text,
			semanticDependencies: (await service.decompileFunction(request, CancellationToken.None)).semanticDependencies,
		}, { text: 'typed saved result', semanticDependencies: typedDependencies });
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

	test('keys the memory cache by the accepted semantic snapshot', async () => {
		let invocations = 0;
		let semanticDependencies: IDecompilationSemanticDependencies = { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] };
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			async decompileFunction() {
				invocations++;
				return { ...result, text: `result ${invocations}` };
			},
		};
		const service = new DelverDecompilerService(backend, undefined, () => semanticDependencies);
		const initial = await service.decompileFunction(request, CancellationToken.None);
		semanticDependencies = typedDependencies;
		const typed = await service.decompileFunction(request, CancellationToken.None);
		semanticDependencies = { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] };
		const restored = await service.decompileFunction(request, CancellationToken.None);

		assert.deepStrictEqual({
			initial: initial.text,
			typed: typed.text,
			restored: restored.text,
			invocations,
		}, { initial: 'result 1', typed: 'result 2', restored: 'result 1', invocations: 2 });
	});

	test('runs an explicit refresh even while a cached-path request is in flight', async () => {
		const completions: ((value: IDecompiledFunction) => void)[] = [];
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			decompileFunction: async () => new Promise<IDecompiledFunction>(resolve => completions.push(resolve)),
		};
		const service = new DelverDecompilerService(backend);
		const first = service.decompileFunction(request, CancellationToken.None);
		const refreshed = service.redecompileFunction(request, CancellationToken.None);
		completions[0](result);
		completions[1]({ ...result, text: 'refreshed' });

		assert.deepStrictEqual({
			invocations: completions.length,
			first: (await first).text,
			refreshed: (await refreshed).text,
			cached: (await service.decompileFunction(request, CancellationToken.None)).text,
		}, {
			invocations: 2,
			first: result.text,
			refreshed: 'refreshed',
			cached: 'refreshed',
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
			result: await backend.decompileFunction({ ...request, semanticDependencies: typedDependencies }, CancellationToken.None),
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
				semanticDependencies: typedDependencies,
			},
			received: ['session-1', '0x1000', 'a'.repeat(64), 'C:\\ghidra', 'C:\\Python\\python.exe'],
			operationIdLength: 36,
		});
	});

	test('carries accepted composites into the snapshot, ahead of the declarations that use them', () => {
		// The ordering is a contract with the worker, not a detail: it defines
		// composites first so a declaration at an address can name a struct the
		// same snapshot introduced. Composites ascend by name and declarations
		// by RVA, which is what both decoders require.
		const config = JSON.stringify({ kind: 'struct', size: 16, fields: [{ offset: 0, name: 'flags', type: 'uint32_t' }] });
		const interpretation = new FakeSemanticInterpretation([
			{ anchor: { kind: 'type', contentHash: request.contentHash, name: 'Config' }, op: EditOp.CompositeType, value: config },
			{ anchor: { kind: 'type', contentHash: request.contentHash, name: 'Alpha' }, op: EditOp.CompositeType, value: JSON.stringify({ kind: 'struct', size: 4, fields: [] }) },
			{ anchor: { kind: 'image', contentHash: request.contentHash, rva: 0x3000n }, op: EditOp.DataType, value: 'struct Config' },
		]);

		assert.deepStrictEqual(semanticDependenciesFor(interpretation as unknown as IDelverInterpretationService, request.contentHash), {
			schemaVersion: 2,
			composites: [
				{ name: 'Alpha', kind: 'struct', size: 4, fields: [] },
				{ name: 'Config', kind: 'struct', size: 16, fields: [{ offset: 0, name: 'flags', type: 'uint32_t' }] },
			],
			dataTypes: [{ rva: '0x3000', declaration: 'struct Config' }],
			functionPrototypes: [],
		});
	});

	test('refuses a snapshot past its bounds rather than truncating it', async () => {
		// A truncated snapshot would decompile against *some* of the analyst's
		// accepted types and present the result as though all of them applied,
		// which is worse than not answering. Refused before the request is built,
		// so the caller is not told after the whole thing crossed the pipe.
		const analysisService: Partial<IDelverAnalysisService> = {
			async decompilerStatus() {
				return { state: 'ready', backendId: 'ghidra-headless', backendVersion: '12.1', adapterVersion: '1', label: 'Headless', processGeneration: 1, spawnMs: 2, handshakeMs: 3 };
			},
			async decompileFunction() { throw new Error('the backend must not be reached'); },
		};
		const configuration = (backend: string): Partial<IConfigurationService> => ({
			getValue: <T>(key?: string | object) => (key === DELVER_DECOMPILER_BACKEND_SETTING
				? backend
				: key === 'delver.decompiler.ghidraHome' ? 'C:\ghidra' : 'C:\Python\python.exe') as T,
		});
		const oversized: IDecompilationSemanticDependencies = {
			schemaVersion: 2,
			composites: [],
			dataTypes: Array.from({ length: 10_001 }, (_unused, index) => ({ rva: `0x${(0x3000 + index).toString(16)}`, declaration: 'uint32_t' })),
			functionPrototypes: [],
		};
		const refusal = async (backend: string, semanticDependencies: IDecompilationSemanticDependencies): Promise<string> => {
			const target = new SharedProcessDecompilerBackend(
				analysisService as IDelverAnalysisService,
				configuration(backend) as IConfigurationService,
			);
			try {
				await target.decompileFunction({ ...request, semanticDependencies }, CancellationToken.None);
				return 'resolved';
			} catch (error) {
				return (error as Error).message;
			}
		};

		assert.deepStrictEqual({
			// Headless no longer refuses here: it declares that it cannot apply
			// semantics, and the *service* answers against the empty snapshot
			// instead. See the test below.
			headlessWithTypes: await refusal('headless', typedDependencies),
			headlessWithout: await refusal('headless', { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] }),
			overLimit: await refusal('pyghidra', oversized),
			// The composite array has its own cap, and it is checked in the same
			// place: a bound only the worker enforces is one the caller learns
			// about after paying to send everything.
			overCompositeLimit: await refusal('pyghidra', {
				schemaVersion: 2,
				composites: Array.from({ length: 1_001 }, (_unused, index) => ({ name: `S${index}`, kind: 'struct' as const, size: 4, fields: [] })),
				dataTypes: [],
				functionPrototypes: [],
			}),
		}, {
			headlessWithTypes: 'the backend must not be reached',
			headlessWithout: 'the backend must not be reached',
			overLimit: 'This project has more accepted data types, function prototypes, or structures than the decompiler backend accepts. Retire some before decompiling.',
			overCompositeLimit: 'This project has more accepted data types, function prototypes, or structures than the decompiler backend accepts. Retire some before decompiling.',
		});
	});

	test('answers against the empty snapshot when the backend cannot apply types, and says so', async () => {
		// The trap this closes: one accepted type used to remove *all* pseudocode
		// on a backend that cannot apply declarations. Saved text no longer
		// matched the snapshot and nothing would produce new text, so every
		// function in the image went blank, silently, until a function was opened.
		//
		// A backend that cannot apply them is answering against no accepted
		// semantics, so that is what the request carries and what the cache is
		// keyed on. Saved pseudocode produced before any type was accepted then
		// matches again — and the result still has to say the types were skipped,
		// because pseudocode that quietly ignores them is a confident answer to a
		// question nobody asked.
		let requested: IDecompilationSemanticDependencies | undefined;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			appliesSemantics: false,
			async decompileFunction(call) {
				requested = call.semanticDependencies;
				return result;
			},
		};
		const service = new DelverDecompilerService(backend, undefined, () => typedDependencies);

		const first = await service.decompileFunction(request, CancellationToken.None);
		const second = await service.decompileFunction(request, CancellationToken.None);

		assert.deepStrictEqual({
			reachedBackendWith: requested,
			semanticsIgnored: first.semanticsIgnored,
			// The second call is a cache hit and must carry the flag too: it is a
			// property of answering this request, not of the stored text.
			cachedAlsoIgnored: second.semanticsIgnored,
			text: first.text,
		}, {
			reachedBackendWith: { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] },
			semanticsIgnored: true,
			cachedAlsoIgnored: true,
			text: result.text,
		});
	});

	test('keeps serving saved pseudocode on a backend that cannot apply accepted types', async () => {
		// The concrete loss this closes. Pseudocode saved before any type was
		// accepted carries no snapshot; once a type is accepted it stopped
		// matching and was skipped, and the backend that would have replaced it
		// refused — so the analyst was left with nothing. Attributing the answer
		// to the snapshot it was actually produced against makes the saved text
		// match again, and no backend is started at all.
		let reachedBackend = false;
		const backend: IDelverDecompilerBackend = {
			status: { state: 'ready', available: true, backendId: 'test', label: 'Test' },
			appliesSemantics: false,
			async decompileFunction() {
				reachedBackend = true;
				return result;
			},
		};
		const service = new DelverDecompilerService(
			backend,
			() => snapshot([{ backendId: 'ghidra-headless', backendVersion: '12.1', functionRva: '0x1000', serialized: serializedResult(0x1000n, 'saved before any type') }]),
			() => typedDependencies,
		);

		const served = await service.decompileFunction(request, CancellationToken.None);

		assert.deepStrictEqual({
			text: served.text,
			provenance: served.provenance,
			semanticsIgnored: served.semanticsIgnored,
			reachedBackend,
			diagnostic: service.savedResultDiagnostic(request),
		}, {
			text: 'saved before any type',
			provenance: 'saved',
			semanticsIgnored: true,
			reachedBackend: false,
			// Nothing was skipped, so there is nothing to explain.
			diagnostic: undefined,
		});
	});

	test('retains a semantic snapshot only when there is one to retain', async () => {
		// The decoder reads an absent snapshot as the empty one, so writing the
		// empty one out says nothing — at roughly seventy bytes per saved function
		// in a portable project whose common case is no authored types at all.
		const retained: string[] = [];
		const analysisService: Partial<IDelverAnalysisService> = {
			async decompilerStatus() {
				return { state: 'ready', backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 1, spawnMs: 2, handshakeMs: 3 };
			},
			async decompileFunction() {
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
			getValue: <T>(key?: string | object) => (key === 'delver.decompiler.ghidraHome' ? 'C:\ghidra' : 'C:\Python\python.exe') as T,
		};
		const projectService: Partial<IDelverProjectService> = {
			projectPath: () => 'C:\projects\sample.delverdb',
			async recordDecompilation(_contentHash, result) { retained.push(result.serialized); },
		};
		const backend = new SharedProcessDecompilerBackend(
			analysisService as IDelverAnalysisService,
			configurationService as IConfigurationService,
			projectService as IDelverProjectService,
		);

		await backend.decompileFunction({ ...request, semanticDependencies: { schemaVersion: 2, composites: [], dataTypes: [], functionPrototypes: [] } }, CancellationToken.None);
		await backend.decompileFunction({ ...request, semanticDependencies: typedDependencies }, CancellationToken.None);

		assert.deepStrictEqual(
			retained.map(serialized => (JSON.parse(serialized) as { semanticDependencies?: IDecompilationSemanticDependencies }).semanticDependencies),
			[undefined, typedDependencies],
		);
	});

	test('stays available when a cancellation crosses the shared-process boundary', async () => {
		const analysisService: Partial<IDelverAnalysisService> = {
			async decompilerStatus() {
				return { state: 'ready', backendId: 'ghidra-pyghidra', backendVersion: '12.1', adapterVersion: '1', label: 'PyGhidra', processGeneration: 1, spawnMs: 2, handshakeMs: 3 };
			},
			async decompileFunction() {
				// The channel rebuilds the rejection from its name and message alone,
				// so a cancellation arrives as a plain Error (ADR 0001, "Scope") and
				// `instanceof CancellationError` is false on this side of the boundary.
				const crossed = new Error(new CancellationError().message);
				crossed.name = new CancellationError().name;
				throw crossed;
			},
			async cancelDecompile() { },
		};
		const configurationService: Partial<IConfigurationService> = {
			getValue: <T>(key?: string | object) => (key === 'delver.decompiler.ghidraHome' ? 'C:\\ghidra' : key === 'delver.decompiler.backend' ? 'pyghidra' : 'C:\\Python\\python.exe') as T,
		};
		const backend = new SharedProcessDecompilerBackend(
			analysisService as IDelverAnalysisService,
			configurationService as IConfigurationService,
		);

		await assert.rejects(backend.decompileFunction(request, CancellationToken.None), error => isCancellationError(error));
		assert.strictEqual(backend.status.state, 'ready');
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
