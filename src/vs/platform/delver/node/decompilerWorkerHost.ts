/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, SpawnOptions, spawn } from 'child_process';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';

export const DELVER_DECOMPILER_WORKER_PROTOCOL_VERSION = 1;

interface IWorkerRequest {
	readonly protocolVersion: number;
	readonly id: string;
	readonly method: string;
	readonly params: object;
}

interface IWorkerError {
	readonly code: string;
	readonly message: string;
}

interface IWorkerResponse {
	readonly protocolVersion: number;
	readonly id: string;
	readonly result?: object;
	readonly error?: IWorkerError;
}

interface IPendingRequest {
	readonly resolve: (result: object) => void;
	readonly reject: (error: Error) => void;
}

export interface IDecompilerWorkerInvocation {
	readonly command: string;
	readonly args: readonly string[];
	readonly options: SpawnOptions;
}

export interface IDecompilerWorkerBackendInfo {
	readonly id: string;
	readonly label: string;
	readonly version: string;
	readonly adapterVersion?: string;
}

export interface IDecompilerWorkerStartupDetails {
	readonly hello: IDecompilerWorkerHello;
	readonly generation: number;
	readonly spawnMs: number;
	readonly handshakeMs: number;
	readonly diagnostic: string;
}

export interface IDecompilerWorkerCapabilities {
	readonly decompileFunction: boolean;
	readonly cancel: boolean;
	readonly persistentTargets: boolean;
	readonly addressMappings: boolean;
	readonly variables: boolean;
	readonly intermediateRepresentations: readonly string[];
}

export interface IDecompilerWorkerHello {
	readonly protocolVersion: number;
	readonly backend: IDecompilerWorkerBackendInfo;
	readonly capabilities: IDecompilerWorkerCapabilities;
}

type WorkerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Owns one persistent JSON-lines decompiler process and multiplexes requests by id. */
export class DecompilerWorkerHost extends Disposable {
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, IPendingRequest>();
	private nextRequestId = 1;
	private standardOutputBuffer = '';
	private standardError = '';
	private starting: Promise<IDecompilerWorkerHello> | undefined;
	private processGeneration = 0;
	private spawnMs = 0;
	private handshakeMs = 0;
	private stopping = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(
		private readonly invocation: IDecompilerWorkerInvocation,
		private readonly spawnWorker: WorkerSpawn = (command, args, options) => spawn(command, [...args], options) as ChildProcessWithoutNullStreams,
		private readonly startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
		private readonly shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
	) {
		super();
	}

	start(): Promise<IDecompilerWorkerHello> {
		if (this.stopping) {
			return Promise.reject(new Error('Decompiler worker is shutting down.'));
		}
		if (!this.starting) {
			this.starting = this.startProcess();
		}
		return this.starting;
	}

	get generation(): number {
		return this.processGeneration;
	}

	get diagnostic(): string {
		return this.standardError.trim();
	}

	async details(): Promise<IDecompilerWorkerStartupDetails> {
		const hello = await this.start();
		return { hello, generation: this.generation, spawnMs: this.spawnMs, handshakeMs: this.handshakeMs, diagnostic: this.diagnostic };
	}

	async request(method: string, params: object, token: CancellationToken): Promise<object> {
		if (this.stopping) {
			throw new Error('Decompiler worker is shutting down.');
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		await this.start();
		return this.sendRequest(method, params, token);
	}

	/** Closes the worker input and waits for the backend to release persistent project locks. */
	shutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.stopping = true;
			this.shutdownPromise = this.shutdownProcess();
		}
		return this.shutdownPromise;
	}

	override dispose(): void {
		this.stopping = true;
		this.fail(new Error('Decompiler worker was disposed.'));
		super.dispose();
	}

	private async startProcess(): Promise<IDecompilerWorkerHello> {
		const spawnStarted = Date.now();
		const child = this.spawnWorker(this.invocation.command, this.invocation.args, this.invocation.options);
		this.spawnMs = Date.now() - spawnStarted;
		const handshakeStarted = Date.now();
		this.processGeneration++;
		this.child = child;
		this.standardOutputBuffer = '';
		this.standardError = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => this.acceptStandardOutput(String(chunk)));
		child.stderr.on('data', chunk => this.standardError = `${this.standardError}${String(chunk)}`.slice(-32_768));
		child.once('error', error => this.fail(error, child));
		child.once('exit', code => this.fail(new Error(`Decompiler worker exited with code ${code}: ${this.standardError.trim() || 'no diagnostic output'}`), child, false));

		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		const startupTimeout = new Promise<object>((_resolve, reject) => {
			startupTimer = setTimeout(() => reject(new Error(`Decompiler worker did not complete its handshake within ${this.startupTimeoutMs}ms.`)), this.startupTimeoutMs);
		});
		try {
			const result = await Promise.race([
				this.sendRequest('hello', {}, CancellationToken.None),
				startupTimeout,
			]);
			const hello = readHello(result);
			this.handshakeMs = Date.now() - handshakeStarted;
			return hello;
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const diagnostic = this.standardError.trim();
			const detailedFailure = diagnostic ? new Error(`${failure.message}\n${diagnostic}`) : failure;
			this.fail(detailedFailure, child);
			throw detailedFailure;
		} finally {
			if (startupTimer) {
				clearTimeout(startupTimer);
			}
		}
	}

	private sendRequest(method: string, params: object, token: CancellationToken): Promise<object> {
		if (token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		const child = this.child;
		if (!child || child.killed) {
			return Promise.reject(new Error('Decompiler worker is not running.'));
		}
		const id = `request-${this.nextRequestId++}`;
		const request: IWorkerRequest = { protocolVersion: DELVER_DECOMPILER_WORKER_PROTOCOL_VERSION, id, method, params };

		return new Promise<object>((resolve, reject) => {
			let cancellationListener: IDisposable;
			this.pending.set(id, {
				resolve: result => {
					cancellationListener.dispose();
					resolve(result);
				},
				reject: error => {
					cancellationListener.dispose();
					reject(error);
				},
			});
			cancellationListener = token.onCancellationRequested(() => {
				if (!this.pending.delete(id)) {
					return;
				}
				cancellationListener.dispose();
				reject(new CancellationError());
				this.write({
					protocolVersion: DELVER_DECOMPILER_WORKER_PROTOCOL_VERSION,
					id: `request-${this.nextRequestId++}`,
					method: 'cancel',
					params: { requestId: id },
				});
			});
			this.write(request);
		});
	}

	private write(request: IWorkerRequest): void {
		// CPython's Windows pipe reader does not release a newline-terminated
		// readline() while Node keeps the persistent stdin pipe open unless the
		// delimiter is CRLF. EOF masked this in one-shot smoke tests.
		const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
		this.child?.stdin.write(`${JSON.stringify(request)}${lineEnding}`);
	}

	private async shutdownProcess(): Promise<void> {
		const child = this.child;
		if (!child) {
			this.fail(new Error('Decompiler worker was shut down.'));
			return;
		}
		const exited = new Promise<void>(resolve => {
			child.once('exit', () => resolve());
			child.once('error', () => resolve());
		});
		const shutdownError = new Error('Decompiler worker was shut down.');
		this.rejectPending(shutdownError);
		child.stdin.end();
		if (!await completesWithin(exited, this.shutdownTimeoutMs)) {
			if (this.child === child && !child.killed) {
				child.kill();
			}
			await completesWithin(exited, this.shutdownTimeoutMs);
		}
		this.fail(shutdownError, child);
	}

	private acceptStandardOutput(chunk: string): void {
		this.standardOutputBuffer += chunk;
		for (;;) {
			const newline = this.standardOutputBuffer.indexOf('\n');
			if (newline < 0) {
				return;
			}
			const line = this.standardOutputBuffer.slice(0, newline).trim();
			this.standardOutputBuffer = this.standardOutputBuffer.slice(newline + 1);
			if (line) {
				this.acceptResponse(line);
			}
		}
	}

	private acceptResponse(line: string): void {
		let response: IWorkerResponse;
		try {
			response = JSON.parse(line) as IWorkerResponse;
		} catch {
			this.fail(new Error('Decompiler worker returned malformed JSON.'));
			return;
		}
		if (response.protocolVersion !== DELVER_DECOMPILER_WORKER_PROTOCOL_VERSION || typeof response.id !== 'string') {
			this.fail(new Error('Decompiler worker returned an incompatible response.'));
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}
		this.pending.delete(response.id);
		if (response.error) {
			pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
		} else if (response.result && typeof response.result === 'object') {
			pending.resolve(response.result);
		} else {
			pending.reject(new Error('Decompiler worker response has neither a result nor an error.'));
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private fail(error: Error, expectedChild?: ChildProcessWithoutNullStreams, terminate = true): void {
		if (expectedChild && this.child !== expectedChild) {
			return;
		}
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		this.rejectPending(error);
		if (terminate && child && !child.killed) {
			child.kill();
		}
	}
}

async function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(() => true),
			new Promise<boolean>(resolve => timer = setTimeout(() => resolve(false), timeoutMs)),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function readHello(result: object): IDecompilerWorkerHello {
	const hello = result as Partial<IDecompilerWorkerHello>;
	if (hello.protocolVersion !== DELVER_DECOMPILER_WORKER_PROTOCOL_VERSION
		|| typeof hello.backend?.id !== 'string'
		|| typeof hello.backend.label !== 'string'
		|| typeof hello.backend.version !== 'string'
		|| hello.capabilities?.decompileFunction !== true) {
		throw new Error('Decompiler worker returned an invalid hello response.');
	}
	return hello as IDecompilerWorkerHello;
}
