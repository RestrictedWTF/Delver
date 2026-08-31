/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DecompilerWorkerHost } from '../../node/decompilerWorkerHost.js';

suite('DecompilerWorkerHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('starts once and multiplexes JSON-lines requests', async () => {
		const process = createFakeProcess(request => {
			const result = request.method === 'hello'
				? {
					protocolVersion: 1,
					backend: { id: 'fake', label: 'Fake', version: '1' },
					capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
				}
				: { echoedMethod: request.method };
			return { protocolVersion: 1, id: request.id, result };
		});
		let spawns = 0;
		const host = new DecompilerWorkerHost(
			{ command: 'python', args: ['worker.py'], options: {} },
			() => {
				spawns++;
				return process.child;
			},
		);

		assert.deepStrictEqual({
			hello: await host.start(),
			result: await host.request('decompileFunction', { functionRva: '0x1000' }, CancellationToken.None),
			spawns,
		}, {
			hello: {
				protocolVersion: 1,
				backend: { id: 'fake', label: 'Fake', version: '1' },
				capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
			},
			result: { echoedMethod: 'decompileFunction' },
			spawns: 1,
		});
		host.dispose();
	});

	test('reports progress without completing the request it belongs to', async () => {
		// A progress line and a result line are answers to the same request. If
		// the first were taken as the answer, the caller would be handed a
		// partial state and the real result would arrive for a request nothing
		// is waiting on.
		const process = createFakeProcess(request => request.method === 'hello'
			? { protocolVersion: 1, id: request.id, result: { protocolVersion: 1, backend: { id: 'fake', label: 'Fake', version: '1' }, capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] } } }
			: [
				{ protocolVersion: 1, id: request.id, progress: { message: 'Function Start Search', fraction: 0.25 } },
				// Malformed enough to be dropped rather than reported: a
				// fraction outside 0..1 is not a fraction.
				{ protocolVersion: 1, id: request.id, progress: { message: 'Stack', fraction: 12 } },
				{ protocolVersion: 1, id: request.id, result: { analysisComplete: true } },
			]);
		const host = new DecompilerWorkerHost({ command: 'python', args: ['worker.py'], options: {} }, () => process.child);
		await host.start();

		const reported: unknown[] = [];
		const result = await host.request('analyzeTarget', { targetId: 't' }, CancellationToken.None, progress => reported.push(progress));

		assert.deepStrictEqual({ result, reported }, {
			result: { analysisComplete: true },
			reported: [
				{ message: 'Function Start Search', fraction: 0.25 },
				{ message: 'Stack', fraction: undefined },
			],
		});
		host.dispose();
	});

	test('a caller that asked for no progress still gets its result', async () => {
		const process = createFakeProcess(request => request.method === 'hello'
			? { protocolVersion: 1, id: request.id, result: { protocolVersion: 1, backend: { id: 'fake', label: 'Fake', version: '1' }, capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] } } }
			: [
				{ protocolVersion: 1, id: request.id, progress: { message: 'ignored' } },
				{ protocolVersion: 1, id: request.id, result: { done: true } },
			]);
		const host = new DecompilerWorkerHost({ command: 'python', args: ['worker.py'], options: {} }, () => process.child);
		await host.start();

		assert.deepStrictEqual(await host.request('analyzeTarget', {}, CancellationToken.None), { done: true });
		host.dispose();
	});

	test('uses a Windows-compatible persistent pipe delimiter', async () => {
		const fakeProcess = createFakeProcess(request => ({
			protocolVersion: 1,
			id: request.id,
			result: {
				protocolVersion: 1,
				backend: { id: 'fake', label: 'Fake', version: '1' },
				capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
			},
		}));
		let input = '';
		fakeProcess.child.stdin.on('data', chunk => input += String(chunk));
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => fakeProcess.child);

		await host.start();

		assert.strictEqual(input.endsWith(process.platform === 'win32' ? '\r\n' : '\n'), true);
		host.dispose();
	});

	test('cancels an in-flight request through the worker protocol', async () => {
		const methods: string[] = [];
		const process = createFakeProcess(request => {
			methods.push(request.method);
			if (request.method === 'hello') {
				return {
					protocolVersion: 1,
					id: request.id,
					result: {
						protocolVersion: 1,
						backend: { id: 'fake', label: 'Fake', version: '1' },
						capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
					},
				};
			}
			return undefined;
		});
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child);
		const source = new CancellationTokenSource();
		const pending = host.request('decompileFunction', {}, source.token);
		await host.start();
		source.cancel();

		await assert.rejects(pending, error => isCancellationError(error));
		assert.deepStrictEqual(methods, ['hello', 'decompileFunction', 'cancel']);
		source.dispose();
		host.dispose();
	});

	test('terminates a worker that never completes its handshake', async () => {
		const process = createFakeProcess(() => undefined);
		let kills = 0;
		process.child.kill = () => {
			kills++;
			return true;
		};
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child, 1);
		const startup = host.start();
		process.stderr.write('PyGhidra startup exploded');

		await assert.rejects(startup, /did not complete its handshake[\s\S]*PyGhidra startup exploded/);
		assert.strictEqual(kills, 1);
		host.dispose();
	});

	test('reports the actual process generation and startup timings', async () => {
		const process = createFakeProcess(request => ({
			protocolVersion: 1,
			id: request.id,
			result: {
				protocolVersion: 1,
				backend: { id: 'fake', label: 'Fake', version: '1', adapterVersion: '2' },
				capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
			},
		}));
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child);
		const details = await host.details();

		assert.deepStrictEqual({
			backend: details.hello.backend,
			generation: details.generation,
			nonNegativeTimings: details.spawnMs >= 0 && details.handshakeMs >= 0,
		}, {
			backend: { id: 'fake', label: 'Fake', version: '1', adapterVersion: '2' },
			generation: 1,
			nonNegativeTimings: true,
		});
		host.dispose();
	});

	test('waits for graceful worker exit before completing shutdown', async () => {
		const process = createFakeProcess(request => ({
			protocolVersion: 1,
			id: request.id,
			result: {
				protocolVersion: 1,
				backend: { id: 'fake', label: 'Fake', version: '1' },
				capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
			},
		}));
		let kills = 0;
		process.child.kill = () => {
			kills++;
			return true;
		};
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child);
		await host.start();
		let completed = false;
		const shutdown = host.shutdown().then(() => completed = true);
		await new Promise<void>(resolve => setImmediate(resolve));

		assert.deepStrictEqual({ inputEnded: process.child.stdin.writableEnded, completed, kills }, { inputEnded: true, completed: false, kills: 0 });
		process.child.emit('exit', 0);
		await shutdown;
		assert.deepStrictEqual({ completed, kills }, { completed: true, kills: 0 });
		host.dispose();
	});

	test('escalates to SIGKILL only after a worker ignores the closed input and the signal', async () => {
		const process = createFakeProcess(helloResponse);
		const signals: (NodeJS.Signals | number | undefined)[] = [];
		process.child.kill = (signal?: NodeJS.Signals | number) => {
			signals.push(signal);
			(process.child as { killed: boolean }).killed = true;
			return true;
		};
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child, 30_000, 1);
		await host.start();

		await host.shutdown();

		assert.deepStrictEqual(signals, [undefined, 'SIGKILL']);
		host.dispose();
	});

	test('fails one request instead of the process when the worker input pipe breaks', async () => {
		const process = createFakeProcess(helloResponse);
		const host = new DecompilerWorkerHost({ command: 'python', args: [], options: {} }, () => process.child, 30_000, 1);
		await host.start();
		// A worker that died without being reaped still looks writable, and the
		// broken pipe is reported on the stream rather than on the child. Before
		// the stream had an `error` listener this took the shared process with it.
		process.child.stdin.destroy();

		await assert.rejects(host.request('decompileFunction', {}, CancellationToken.None), /input stream failed/);
		host.dispose();
	});
});

function helloResponse(request: IFakeRequest): IFakeResponse {
	return {
		protocolVersion: 1,
		id: request.id,
		result: {
			protocolVersion: 1,
			backend: { id: 'fake', label: 'Fake', version: '1' },
			capabilities: { decompileFunction: true, cancel: true, persistentTargets: true, addressMappings: true, variables: true, intermediateRepresentations: [] },
		},
	};
}

interface IFakeRequest {
	readonly id: string;
	readonly method: string;
}

interface IFakeResponse {
	readonly protocolVersion: number;
	readonly id: string;
	readonly result?: object;
	readonly progress?: { readonly message?: string; readonly fraction?: number };
}

/** Several lines may answer one request: progress reports, then the result. */
function createFakeProcess(respond: (request: IFakeRequest) => IFakeResponse | readonly IFakeResponse[] | undefined): { readonly child: ChildProcessWithoutNullStreams; readonly stderr: PassThrough } {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let input = '';
	stdin.setEncoding('utf8');
	stdin.on('data', chunk => {
		input += String(chunk);
		for (;;) {
			const newline = input.indexOf('\n');
			if (newline < 0) {
				break;
			}
			const request = JSON.parse(input.slice(0, newline)) as IFakeRequest;
			input = input.slice(newline + 1);
			const response = respond(request);
			const lines = response === undefined ? [] : (Array.isArray(response) ? response : [response as IFakeResponse]);
			for (const emitted of lines) {
				stdout.write(`${JSON.stringify(emitted)}\n`);
			}
		}
	});
	const child = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		stderr,
		killed: false,
		kill: () => true,
	}) as unknown as ChildProcessWithoutNullStreams;
	return { child, stderr };
}
