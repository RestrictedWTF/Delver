/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDtpConnectionTransport } from './connection';
import { IRelayAttempt, IRelayProcess, RelayProcessFactory } from './relayProcess';
import { RelayProcessTransport } from './relayTransport';

const RELAY_READY_MAX_BYTES = 4 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_STABLE_LIFETIME_MS = 30_000;
const DEFAULT_RESTART_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

interface IDisposableConnection {
	dispose(closeTransport?: boolean): void;
}

export interface IRelayTimers {
	setTimeout(listener: () => void, delay: number): object;
	clearTimeout(timer: object): void;
}

export interface IDelverAgentRelaySupervisorOptions {
	readonly executable: string;
	readonly spawn: RelayProcessFactory;
	readonly createAttempt: () => IRelayAttempt;
	readonly createConnection: (transport: IDtpConnectionTransport, token: string) => IDisposableConnection;
	readonly timers?: IRelayTimers;
	readonly readinessTimeoutMs?: number;
	readonly stableLifetimeMs?: number;
	readonly restartDelaysMs?: readonly number[];
	readonly maxConsecutiveFailures?: number;
}

interface IActiveRelayAttempt {
	readonly id: number;
	readonly descriptor: IRelayAttempt;
	readonly process: IRelayProcess;
	readonly transport: RelayProcessTransport;
	readonly connection: IDisposableConnection;
	readonly removeExitListener: () => void;
	readonly removeErrorListener: () => void;
	readonly cancelReadiness: (error: Error) => void;
	removePostReadyStderrListener: (() => void) | undefined;
	ready: boolean;
	finished: boolean;
	stableTimer: object | undefined;
}

const defaultTimers: IRelayTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Supervises one unpublished owner-only relay endpoint at a time. */
export class DelverAgentRelaySupervisor {
	private readonly timers: IRelayTimers;
	private readonly restartDelaysMs: readonly number[];
	private readonly maxConsecutiveFailures: number;
	private activeAttempt: IActiveRelayAttempt | undefined;
	private restartTimer: object | undefined;
	private nextAttemptId = 0;
	private consecutiveFailures = 0;
	private active = false;
	private disposed = false;
	private startPromise: Promise<void> | undefined;
	private resolveStart: (() => void) | undefined;
	private rejectStart: ((error: Error) => void) | undefined;

	constructor(private readonly options: IDelverAgentRelaySupervisorOptions) {
		this.timers = options.timers ?? defaultTimers;
		this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
		this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? this.restartDelaysMs.length;
		if (this.restartDelaysMs.length === 0 || this.restartDelaysMs.some(delay => !Number.isFinite(delay) || delay < 0)) {
			throw new Error('The Delver relay restart delays must be non-negative finite values.');
		}
		if (!Number.isSafeInteger(this.maxConsecutiveFailures) || this.maxConsecutiveFailures < 1) {
			throw new Error('The Delver relay failure limit must be a positive safe integer.');
		}
	}

	start(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error('The Delver relay supervisor is disposed.'));
		}
		if (this.startPromise) {
			return this.startPromise;
		}
		this.active = true;
		this.startPromise = new Promise<void>((resolve, reject) => {
			this.resolveStart = resolve;
			this.rejectStart = reject;
		});
		void this.beginAttempt();
		return this.startPromise;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.active = false;
		if (this.restartTimer) {
			this.timers.clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.activeAttempt) {
			this.finishAttempt(this.activeAttempt, false, true);
		}
		this.rejectPendingStart(new Error('The Delver relay supervisor was disposed before becoming ready.'));
	}

	private async beginAttempt(): Promise<void> {
		if (!this.active || this.disposed || this.activeAttempt) {
			return;
		}

		let descriptor: IRelayAttempt;
		try {
			descriptor = this.options.createAttempt();
		} catch {
			this.recordFailureAndRestart();
			return;
		}

		let process: IRelayProcess;
		try {
			process = this.options.spawn(this.options.executable, descriptor.endpoint);
		} catch {
			void descriptor.cleanup().catch(() => undefined);
			this.recordFailureAndRestart();
			return;
		}

		let transport: RelayProcessTransport;
		try {
			transport = new RelayProcessTransport(process);
		} catch {
			// Nothing else owns the spawned child until the transport wraps it.
			process.terminate();
			void descriptor.cleanup().catch(() => undefined);
			this.recordFailureAndRestart();
			return;
		}

		let connection: IDisposableConnection;
		try {
			connection = this.options.createConnection(transport, descriptor.token);
		} catch {
			transport.terminate();
			void descriptor.cleanup().catch(() => undefined);
			this.recordFailureAndRestart();
			return;
		}

		const id = ++this.nextAttemptId;
		const readiness = createRelayReadinessWait(
			process,
			this.timers,
			this.options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		);
		const attempt: IActiveRelayAttempt = {
			id,
			descriptor,
			process,
			transport,
			connection,
			removeExitListener: process.onExit(code => this.finishAttempt(attempt, attempt.ready && code === 0, false)),
			removeErrorListener: process.onError(() => this.finishAttempt(attempt, false, true)),
			cancelReadiness: readiness.cancel,
			removePostReadyStderrListener: undefined,
			ready: false,
			finished: false,
			stableTimer: undefined,
		};
		this.activeAttempt = attempt;

		try {
			await readiness.promise;
		} catch {
			this.finishAttempt(attempt, false, true);
			return;
		}

		if (attempt.finished || this.activeAttempt !== attempt || !this.active || this.disposed) {
			return;
		}
		attempt.ready = true;
		attempt.removePostReadyStderrListener = process.onStderr(() => {
			// Drain and discard post-readiness diagnostics. They are not protocol
			// bytes and may contain environment-specific paths.
		});
		attempt.stableTimer = this.timers.setTimeout(() => {
			if (this.activeAttempt === attempt && !attempt.finished) {
				this.consecutiveFailures = 0;
			}
		}, this.options.stableLifetimeMs ?? DEFAULT_STABLE_LIFETIME_MS);
		this.resolveStart?.();
		this.resolveStart = undefined;
		this.rejectStart = undefined;
	}

	private finishAttempt(attempt: IActiveRelayAttempt, cleanExit: boolean, terminate: boolean): void {
		if (attempt.finished) {
			return;
		}
		attempt.finished = true;
		attempt.cancelReadiness(new Error('The Delver relay attempt ended before readiness.'));
		attempt.removeExitListener();
		attempt.removeErrorListener();
		attempt.removePostReadyStderrListener?.();
		attempt.removePostReadyStderrListener = undefined;
		if (attempt.stableTimer) {
			this.timers.clearTimeout(attempt.stableTimer);
			attempt.stableTimer = undefined;
		}
		attempt.connection.dispose(false);
		if (terminate) {
			attempt.transport.terminate();
		}
		void attempt.descriptor.cleanup().catch(() => undefined);
		if (this.activeAttempt === attempt) {
			this.activeAttempt = undefined;
		}
		if (!this.active || this.disposed) {
			return;
		}
		if (cleanExit) {
			this.consecutiveFailures = 0;
		}
		this.recordFailureAndRestart(cleanExit);
	}

	private recordFailureAndRestart(cleanExit = false): void {
		if (!cleanExit) {
			this.consecutiveFailures++;
		}
		if (this.consecutiveFailures > this.maxConsecutiveFailures) {
			this.active = false;
			this.rejectPendingStart(new Error('The Delver relay could not be started safely.'));
			return;
		}
		const delayIndex = Math.min(Math.max(this.consecutiveFailures - 1, 0), this.restartDelaysMs.length - 1);
		this.restartTimer = this.timers.setTimeout(() => {
			this.restartTimer = undefined;
			void this.beginAttempt();
		}, this.restartDelaysMs[delayIndex]);
	}

	private rejectPendingStart(error: Error): void {
		this.rejectStart?.(error);
		this.resolveStart = undefined;
		this.rejectStart = undefined;
	}
}

/** Waits for one strict, bounded JSON readiness line on stderr. */
export function waitForRelayReady(process: IRelayProcess, timers: IRelayTimers, timeoutMs: number): Promise<void> {
	return createRelayReadinessWait(process, timers, timeoutMs).promise;
}

function createRelayReadinessWait(
	process: IRelayProcess,
	timers: IRelayTimers,
	timeoutMs: number,
): { readonly promise: Promise<void>; readonly cancel: (error: Error) => void } {
	let cancel = (_error: Error) => { };
	const promise = new Promise<void>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		let settled = false;
		let removeStderr = () => { };
		let removeExit = () => { };
		let removeError = () => { };
		let timeout: object | undefined = undefined;
		const finish = (error?: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			removeStderr();
			removeExit();
			removeError();
			if (timeout) {
				timers.clearTimeout(timeout);
			}
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		cancel = error => finish(error);
		removeStderr = process.onStderr(data => {
			buffer = Buffer.concat([buffer, data]);
			if (buffer.length > RELAY_READY_MAX_BYTES) {
				finish(new Error('The Delver relay readiness record is too large.'));
				return;
			}
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				return;
			}
			if (newline !== buffer.length - 1) {
				finish(new Error('The Delver relay emitted unexpected readiness data.'));
				return;
			}
			let line = buffer.subarray(0, newline);
			if (line.at(-1) === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			try {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
				const value: unknown = JSON.parse(text);
				if (!isRelayReadyRecord(value)) {
					throw new Error();
				}
				finish();
			} catch {
				finish(new Error('The Delver relay readiness record is invalid.'));
			}
		});
		removeExit = process.onExit(() => finish(new Error('The Delver relay exited before readiness.')));
		removeError = process.onError(() => finish(new Error('The Delver relay failed before readiness.')));
		timeout = timers.setTimeout(
			() => finish(new Error('The Delver relay readiness timed out.')),
			timeoutMs,
		);
	});
	return { promise, cancel };
}

/** Strictly recognizes the native relay readiness record. */
export function isRelayReadyRecord(value: unknown): value is { readonly event: 'ready'; readonly schemaVersion: 1 } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 2 && record.event === 'ready' && record.schemaVersion === 1;
}
