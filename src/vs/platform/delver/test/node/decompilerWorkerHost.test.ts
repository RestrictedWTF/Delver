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
});

interface IFakeRequest {
	readonly id: string;
	readonly method: string;
}

interface IFakeResponse {
	readonly protocolVersion: number;
	readonly id: string;
	readonly result: object;
}

function createFakeProcess(respond: (request: IFakeRequest) => IFakeResponse | undefined): { readonly child: ChildProcessWithoutNullStreams; readonly stderr: PassThrough } {
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
			if (response) {
				stdout.write(`${JSON.stringify(response)}\n`);
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
