/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { IBootstrapPeerIdentity } from './bootstrap';
import { resolveRendezvousRegistryDirectory } from './rendezvousRegistry';

const RELAY_CONTROL_MAX_BYTES = 4 * 1024;
const DEFAULT_DIRECTORY_PREPARATION_TIMEOUT_MS = 5_000;

export interface IRelayProcess {
	write(data: Buffer, callback: (error?: Error | null) => void): boolean;
	onDrain(listener: () => void): () => void;
	endInput(): void;
	onStdout(listener: (data: Buffer) => void): () => void;
	onStderr(listener: (data: Buffer) => void): () => void;
	onExit(listener: (code: number | null) => void): () => void;
	onError(listener: (error: Error) => void): () => void;
	/** Requests exit; `force` escalates past a signal the child is free to ignore. */
	terminate(force?: boolean): void;
}

export interface IRelayAttempt {
	readonly endpoint: string;
	readonly token: string;
	cleanup(): Promise<void>;
}

export interface IBootstrapRelayAttempt {
	readonly endpoint: string;
	cleanup(): Promise<void>;
}

export type RelayProcessFactory = (executable: string, endpoint: string) => IRelayProcess;
export type PrivateDirectoryProcessFactory = (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) => IRelayProcess;

export interface IPrivateDirectoryPreparationOptions {
	readonly platform?: NodeJS.Platform;
	readonly environment?: NodeJS.ProcessEnv;
	readonly spawn?: PrivateDirectoryProcessFactory;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly timers?: {
		setTimeout(listener: () => void, delay: number): object;
		clearTimeout(timer: object): void;
	};
}

/** Resolves only Delver-owned absolute staged binaries, never a PATH fallback. */
export function resolveStagedDelverExecutable(
	extensionPath: string,
	binaryName: string,
	description: string,
	platform: NodeJS.Platform = process.platform,
	exists: (candidate: string) => boolean = fs.existsSync,
): string {
	const executable = platform === 'win32' ? `${binaryName}.exe` : binaryName;
	const applicationRoot = path.resolve(extensionPath, '..', '..');
	const candidates = [
		path.join(applicationRoot, 'delver', 'target', 'debug', executable),
		path.join(applicationRoot, 'resources', 'delver', 'bin', platform, executable),
	];
	for (const candidate of candidates) {
		if (path.isAbsolute(candidate) && exists(candidate)) {
			return candidate;
		}
	}
	throw new Error(`The staged Delver ${description} executable is unavailable.`);
}

/** Resolves only Delver-owned absolute relay paths, never a PATH fallback. */
export function resolveRelayExecutable(
	extensionPath: string,
	platform: NodeJS.Platform = process.platform,
	exists: (candidate: string) => boolean = fs.existsSync,
): string {
	return resolveStagedDelverExecutable(extensionPath, 'delver-agent-relay', 'agent relay', platform, exists);
}

/** Creates a fresh endpoint and an in-memory 256-bit bearer token. */
export function createRelayAttempt(
	platform: NodeJS.Platform = process.platform,
	temporaryDirectory: string = os.tmpdir(),
	createUuid: () => string = randomUUID,
	createTokenBytes: (size: number) => Buffer = randomBytes,
): IRelayAttempt {
	const descriptor = createEndpointAttempt(platform, temporaryDirectory, createUuid);
	const token = createTokenBytes(32).toString('base64url');
	return { ...descriptor, token };
}

/** Creates a fresh non-secret bootstrap endpoint without minting a data credential. */
export function createBootstrapRelayAttempt(
	platform: NodeJS.Platform = process.platform,
	temporaryDirectory: string = os.tmpdir(),
	createUuid: () => string = randomUUID,
): IBootstrapRelayAttempt {
	return createEndpointAttempt(platform, temporaryDirectory, createUuid);
}

function createEndpointAttempt(
	platform: NodeJS.Platform,
	temporaryDirectory: string,
	createUuid: () => string,
): IBootstrapRelayAttempt {
	const identifier = createUuid().replaceAll('-', '');
	if (platform === 'win32') {
		return {
			endpoint: `pipe://delver-agent-${identifier}`,
			cleanup: async () => { },
		};
	}

	const root = path.resolve(temporaryDirectory);
	const directory = path.join(root, `dv-${identifier}`);
	const endpoint = `unix://${path.join(directory, 'session.sock')}`;
	return {
		endpoint,
		cleanup: async () => {
			if (path.dirname(directory) !== root || !path.basename(directory).startsWith('dv-')) {
				throw new Error('Refusing to clean an invalid Delver relay directory.');
			}
			await fs.promises.rm(directory, { recursive: true, force: true });
		},
	};
}

/** Spawns the absolute relay executable with no inherited session credential. */
export function spawnRelayProcess(executable: string, endpoint: string): IRelayProcess {
	return spawnRelay(executable, ['--endpoint', endpoint]);
}

/** Spawns the bootstrap relay mode that reports OS-derived peer identity. */
export function spawnBootstrapRelayProcess(executable: string, endpoint: string): IRelayProcess {
	return spawnRelay(executable, ['--endpoint', endpoint, '--report-peer']);
}

/** Audits the deterministic Windows rendezvous hierarchy in a bounded native helper. */
export function prepareWindowsRendezvousRegistryDirectory(
	executable: string,
	expectedDirectory: string,
	options: IPrivateDirectoryPreparationOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	if (platform !== 'win32') {
		return Promise.reject(new Error('Native rendezvous directory preparation is only supported on Windows.'));
	}
	const resolvedDirectory = resolveRendezvousRegistryDirectory(platform, environment);
	if (path.win32.normalize(expectedDirectory).toLowerCase() !== path.win32.normalize(resolvedDirectory).toLowerCase()) {
		return Promise.reject(new Error('The Windows rendezvous directory does not match the deterministic registry path.'));
	}
	if (!path.isAbsolute(executable)) {
		return Promise.reject(new Error('The Delver agent relay executable path must be absolute.'));
	}
	if (options.signal?.aborted) {
		return Promise.reject(new Error('The Windows rendezvous directory preparation was cancelled.'));
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_DIRECTORY_PREPARATION_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		return Promise.reject(new Error('The Windows rendezvous directory preparation timeout is invalid.'));
	}
	const timers = options.timers ?? {
		setTimeout: (listener: () => void, delay: number) => setTimeout(listener, delay),
		clearTimeout: (timer: object) => clearTimeout(timer as NodeJS.Timeout),
	};
	const childEnvironment = registryDirectoryEnvironment(environment);
	let relayProcess: IRelayProcess;
	try {
		relayProcess = (options.spawn ?? spawnPrivateDirectoryProcess)(
			executable,
			['--prepare-registry-directory'],
			childEnvironment,
		);
	} catch {
		return Promise.reject(new Error('The Windows rendezvous directory helper could not be started.'));
	}

	return new Promise<void>((resolve, reject) => {
		let stderr = Buffer.alloc(0);
		let settled = false;
		let timeout: object | undefined;
		let removeStdout = () => { };
		let removeStderr = () => { };
		let removeExit = () => { };
		let removeError = () => { };
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			removeStdout();
			removeStderr();
			removeExit();
			removeError();
			options.signal?.removeEventListener('abort', handleAbort);
			if (timeout) {
				timers.clearTimeout(timeout);
				timeout = undefined;
			}
			if (error) {
				relayProcess.terminate();
				reject(error);
			} else {
				resolve();
			}
		};
		const handleAbort = () => finish(new Error('The Windows rendezvous directory preparation was cancelled.'));
		removeStdout = relayProcess.onStdout(data => {
			if (data.length > 0) {
				finish(new Error('The Windows rendezvous directory helper wrote unexpected stdout data.'));
			}
		});
		removeStderr = relayProcess.onStderr(data => {
			if (data.length > RELAY_CONTROL_MAX_BYTES - stderr.length) {
				finish(new Error('The Windows rendezvous directory helper response is too large.'));
				return;
			}
			stderr = Buffer.concat([stderr, data]);
		});
		removeExit = relayProcess.onExit(code => {
			if (code !== 0 || !isRegistryDirectoryReadyResponse(stderr)) {
				finish(new Error('The Windows rendezvous directory helper did not complete successfully.'));
				return;
			}
			finish();
		});
		removeError = relayProcess.onError(() => finish(new Error('The Windows rendezvous directory helper failed.')));
		timeout = timers.setTimeout(
			() => finish(new Error('The Windows rendezvous directory preparation timed out.')),
			timeoutMs,
		);
		options.signal?.addEventListener('abort', handleAbort, { once: true });
	});
}

function spawnRelay(executable: string, args: readonly string[], environment = relayEnvironment(process.env, process.platform)): IRelayProcess {
	if (!path.isAbsolute(executable)) {
		throw new Error('The Delver agent relay executable path must be absolute.');
	}
	const child = childProcess.spawn(executable, args, {
		env: environment,
		shell: false,
		stdio: 'pipe',
		windowsHide: true,
	});
	return new NodeRelayProcess(child);
}

function spawnPrivateDirectoryProcess(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv): IRelayProcess {
	return spawnRelay(executable, args, environment);
}

/** Reads one strict peer-attestation record emitted after bootstrap accept. */
export function waitForRelayPeer(
	process: IRelayProcess,
	platform: NodeJS.Platform = globalThis.process.platform,
	signal?: AbortSignal,
): Promise<IBootstrapPeerIdentity> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error, peer?: IBootstrapPeerIdentity) => {
			if (settled) {
				return;
			}
			settled = true;
			removeStderr();
			removeExit();
			removeError();
			signal?.removeEventListener('abort', handleAbort);
			if (error) {
				reject(error);
			} else if (peer) {
				resolve(peer);
			}
		};
		let removeStderr = () => { };
		let removeExit = () => { };
		let removeError = () => { };
		const handleAbort = () => finish(new Error('The Delver relay peer wait was cancelled.'));
		removeStderr = process.onStderr(data => {
			buffer = Buffer.concat([buffer, data]);
			if (buffer.length > RELAY_CONTROL_MAX_BYTES) {
				finish(new Error('The Delver relay peer record is too large.'));
				return;
			}
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				return;
			}
			if (newline !== buffer.length - 1) {
				finish(new Error('The Delver relay emitted unexpected peer data.'));
				return;
			}
			let line = buffer.subarray(0, newline);
			if (line.at(-1) === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			try {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
				const value: unknown = JSON.parse(text);
				const peer = parseRelayPeerRecord(value, platform);
				finish(undefined, peer);
			} catch {
				finish(new Error('The Delver relay peer record is invalid.'));
			}
		});
		removeExit = process.onExit(() => finish(new Error('The Delver relay exited before peer attestation.')));
		removeError = process.onError(() => finish(new Error('The Delver relay failed before peer attestation.')));
		if (signal?.aborted) {
			handleAbort();
		} else {
			signal?.addEventListener('abort', handleAbort, { once: true });
		}
	});
}

/** Returns the minimal environment needed by a native child process. */
export function relayEnvironment(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	if (platform !== 'win32') {
		return {};
	}
	const result: NodeJS.ProcessEnv = {};
	for (const key of ['SystemRoot', 'WINDIR']) {
		if (typeof environment[key] === 'string') {
			result[key] = environment[key];
		}
	}
	return result;
}

/** Returns the credential-free environment used only by the deterministic Windows directory helper. */
export function registryDirectoryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = relayEnvironment(environment, 'win32');
	if (typeof environment.LOCALAPPDATA === 'string') {
		result.LOCALAPPDATA = environment.LOCALAPPDATA;
	}
	return result;
}

function isRegistryDirectoryReadyResponse(data: Buffer): boolean {
	if (data.length === 0 || data.at(-1) !== 0x0a || data.indexOf(0x0a) !== data.length - 1) {
		return false;
	}
	let line = data.subarray(0, data.length - 1);
	if (line.at(-1) === 0x0d) {
		line = line.subarray(0, line.length - 1);
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
		return typeof value === 'object'
			&& value !== null
			&& !Array.isArray(value)
			&& Object.keys(value).sort().join('\0') === 'event\0schemaVersion'
			&& (value as Record<string, unknown>).event === 'registryDirectoryReady'
			&& (value as Record<string, unknown>).schemaVersion === 1;
	} catch {
		return false;
	}
}

/** Strictly decodes the OS-derived peer record emitted by the native relay. */
export function parseRelayPeerRecord(value: unknown, platform: NodeJS.Platform): IBootstrapPeerIdentity {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error();
	}
	const record = value as Record<string, unknown>;
	const expectedKeys = ['event', 'schemaVersion'];
	if (record.processId !== undefined) {
		expectedKeys.push('processId');
	}
	if (record.userId !== undefined) {
		expectedKeys.push('userId');
	}
	if (
		Object.keys(record).sort().join('\0') !== expectedKeys.sort().join('\0')
		|| record.event !== 'peer'
		|| record.schemaVersion !== 1
		|| (record.processId !== undefined && (!Number.isSafeInteger(record.processId) || (record.processId as number) < 1))
		|| (record.userId !== undefined && (!Number.isSafeInteger(record.userId) || (record.userId as number) < 0))
		|| (record.processId === undefined && record.userId === undefined)
	) {
		throw new Error();
	}
	return {
		platform,
		...(record.processId === undefined ? {} : { processId: record.processId as number }),
		...(record.userId === undefined ? {} : { userId: record.userId as number }),
	};
}

/** Adapts one spawned relay child to the stdio contract without unhandled stream failures. */
export class NodeRelayProcess implements IRelayProcess {
	private readonly errorListeners = new Set<(error: Error) => void>();

	constructor(private readonly child: childProcess.ChildProcessWithoutNullStreams) {
		// A stdio failure is routine — the peer goes away mid-write and the pipe
		// reports EPIPE. Without a listener on every stream that becomes an
		// unhandled 'error' event, which terminates the extension host instead of
		// this one relay. Every failure is reported to the relay's own error path
		// so the affected operation fails and the owner can tear the relay down.
		this.child.on('error', error => this.reportError(error));
		this.child.stdin.on('error', error => this.reportError(error));
		this.child.stdout.on('error', error => this.reportError(error));
		this.child.stderr.on('error', error => this.reportError(error));
	}

	write(data: Buffer, callback: (error?: Error | null) => void): boolean {
		return this.child.stdin.write(data, callback);
	}

	onDrain(listener: () => void): () => void {
		this.child.stdin.once('drain', listener);
		return () => this.child.stdin.removeListener('drain', listener);
	}

	endInput(): void {
		this.child.stdin.end();
	}

	onStdout(listener: (data: Buffer) => void): () => void {
		this.child.stdout.on('data', listener);
		return () => this.child.stdout.removeListener('data', listener);
	}

	onStderr(listener: (data: Buffer) => void): () => void {
		this.child.stderr.on('data', listener);
		return () => this.child.stderr.removeListener('data', listener);
	}

	onExit(listener: (code: number | null) => void): () => void {
		this.child.on('exit', listener);
		return () => this.child.removeListener('exit', listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	terminate(force = false): void {
		if (force) {
			this.child.kill('SIGKILL');
			return;
		}
		if (!this.child.killed) {
			this.child.kill();
		}
	}

	private reportError(error: Error): void {
		for (const listener of [...this.errorListeners]) {
			listener(error);
		}
	}
}
