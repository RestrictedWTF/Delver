/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { IBootstrapProvision } from './bootstrap';
import { DelverDtpConnection, IDelverAgentGateway } from './connection';
import { createBootstrapRelayAttempt, IBootstrapRelayAttempt, IRelayProcess, spawnRelayProcess } from './relayProcess';
import { IRelayTimers, waitForRelayReady } from './relaySupervisor';
import { RelayProcessTransport } from './relayTransport';
import { DtpTokenLeaseStore } from './tokenLease';

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_FORCED_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_ABANDON_EXIT_TIMEOUT_MS = 1_000;

export interface IDtpRelayProvisionerOptions {
	readonly executable: string;
	readonly leases: DtpTokenLeaseStore;
	readonly gateway: IDelverAgentGateway;
	readonly createAttempt?: () => IBootstrapRelayAttempt;
	readonly createEndpointGeneration?: () => string;
	readonly spawn?: (executable: string, endpoint: string) => IRelayProcess;
	readonly timers?: IRelayTimers;
	readonly readinessTimeoutMs?: number;
}

const defaultTimers: IRelayTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Provisions one ready private DTP relay and owns all live provisions. */
export class DelverDtpRelayProvisioner {
	private readonly provisions = new Set<DelverDtpRelayProvision>();
	private closeAllPromise: Promise<void> | undefined;
	private generation = 0;
	private closing = false;
	private disposed = false;

	constructor(private readonly options: IDtpRelayProvisionerOptions) {
		const timeout = options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
			throw new Error('The private DTP relay readiness timeout is invalid.');
		}
	}

	async provision(signal: AbortSignal): Promise<DelverDtpRelayProvision> {
		if (this.disposed || this.closing || signal.aborted) {
			throw new Error('Private DTP provisioning was cancelled.');
		}
		const generation = this.generation;
		const attempt = (this.options.createAttempt ?? createBootstrapRelayAttempt)();
		const endpointGeneration = (this.options.createEndpointGeneration ?? randomUUID)();
		if (typeof endpointGeneration !== 'string' || endpointGeneration.length === 0 || endpointGeneration.length > 128) {
			await attempt.cleanup().catch(() => undefined);
			throw new Error('The private DTP endpoint generation is invalid.');
		}
		let relayProcess: IRelayProcess | undefined;
		let transport: RelayProcessTransport | undefined;
		let connection: DelverDtpConnection | undefined;
		let provision: DelverDtpRelayProvision | undefined;
		try {
			relayProcess = (this.options.spawn ?? spawnRelayProcess)(this.options.executable, attempt.endpoint);
			transport = new RelayProcessTransport(relayProcess);
			connection = new DelverDtpConnection(transport, this.options.leases.authenticator(endpointGeneration), this.options.gateway);
			provision = new DelverDtpRelayProvision(
				attempt.endpoint,
				endpointGeneration,
				attempt.cleanup,
				relayProcess,
				transport,
				connection,
				closed => this.provisions.delete(closed),
				this.options.timers ?? defaultTimers,
			);
			this.provisions.add(provision);
			const handleAbort = () => provision?.dispose();
			signal.addEventListener('abort', handleAbort, { once: true });
			try {
				await waitForRelayReady(relayProcess, this.options.timers ?? defaultTimers, this.options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
			} finally {
				signal.removeEventListener('abort', handleAbort);
			}
			if (this.disposed || this.closing || generation !== this.generation || signal.aborted) {
				throw new Error('Private DTP provisioning was cancelled.');
			}
			provision.drainStderr(relayProcess);
			return provision;
		} catch (error) {
			if (provision) {
				provision.dispose();
				await provision.whenClosed();
			} else {
				connection?.dispose(false);
				transport?.terminate();
				relayProcess?.terminate();
				await attempt.cleanup().catch(() => undefined);
			}
			throw error;
		}
	}

	/** Closes every private endpoint from the current window/root generation. */
	closeAll(): Promise<void> {
		if (this.closeAllPromise) {
			return this.closeAllPromise;
		}
		this.closing = true;
		this.generation++;
		const provisions = [...this.provisions];
		for (const provision of provisions) {
			provision.dispose();
		}
		const closePromise = Promise.all(provisions.map(provision => provision.whenClosed())).then(() => undefined);
		const trackedPromise = closePromise.finally(() => {
			if (this.closeAllPromise === trackedPromise) {
				this.closeAllPromise = undefined;
			}
			this.closing = false;
		});
		this.closeAllPromise = trackedPromise;
		return this.closeAllPromise;
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			await (this.closeAllPromise ?? Promise.all([...this.provisions].map(provision => provision.whenClosed())).then(() => undefined));
			return;
		}
		this.disposed = true;
		await this.closeAll();
	}
}

/** A single ready private endpoint whose native relay exits with either side. */
export class DelverDtpRelayProvision implements IBootstrapProvision {
	private readonly closeListeners = new Set<() => void>();
	private readonly closedPromise: Promise<void>;
	private resolveClosed!: () => void;
	private readonly removeTransportCloseListener: () => void;
	private readonly removeProcessExitListener: () => void;
	private readonly removeProcessErrorListener: () => void;
	private removeStderrListener: () => void = () => { };
	private exitTimer: object | undefined;
	private processExited = false;
	private processAbandoned = false;
	private cleanupStarted = false;
	private closed = false;

	constructor(
		readonly endpoint: string,
		readonly endpointGeneration: string,
		private readonly cleanup: () => Promise<void>,
		private readonly process: IRelayProcess,
		private readonly transport: RelayProcessTransport,
		private readonly connection: DelverDtpConnection,
		private readonly onClosed: (provision: DelverDtpRelayProvision) => void = () => { },
		private readonly timers: IRelayTimers = defaultTimers,
		private readonly forcedExitTimeoutMs: number = DEFAULT_FORCED_EXIT_TIMEOUT_MS,
		private readonly abandonExitTimeoutMs: number = DEFAULT_ABANDON_EXIT_TIMEOUT_MS,
	) {
		this.closedPromise = new Promise(resolve => this.resolveClosed = resolve);
		this.removeTransportCloseListener = transport.onClose(() => this.beginClose());
		this.removeProcessExitListener = process.onExit(() => {
			this.processExited = true;
			this.beginClose();
		});
		this.removeProcessErrorListener = process.onError(() => {
			// A child-process error is terminal for this one-shot owner even when
			// Node cannot subsequently produce an exit event (for example ENOENT).
			this.processExited = true;
			this.beginClose();
		});
	}

	onDidClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => { };
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	dispose(): void {
		if (this.closed) {
			return;
		}
		this.connection.dispose(false);
		this.transport.terminate();
	}

	whenClosed(): Promise<void> {
		return this.closedPromise;
	}

	drainStderr(process: IRelayProcess): void {
		if (this.closed) {
			return;
		}
		this.removeStderrListener();
		this.removeStderrListener = process.onStderr(() => {
			// Drain bounded native diagnostics without logging environment data.
		});
	}

	private beginClose(): void {
		if (this.closed) {
			this.finishCleanupAfterExit();
			return;
		}
		this.closed = true;
		this.removeTransportCloseListener();
		this.removeStderrListener();
		this.connection.dispose(false);
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch {
				// Cleanup remains authoritative when a lease observer fails.
			}
		}
		this.closeListeners.clear();
		this.onClosed(this);
		this.armExitEscalation();
		this.finishCleanupAfterExit();
	}

	/**
	 * Bounds the wait for the child to exit. A relay that ignores the graceful
	 * signal is killed outright, and cleanup completes even if it never exits —
	 * deactivation awaits `whenClosed()` and must not hang on a wedged child.
	 */
	private armExitEscalation(): void {
		if (this.processExited || this.exitTimer) {
			return;
		}
		this.exitTimer = this.timers.setTimeout(() => {
			this.exitTimer = this.timers.setTimeout(() => {
				this.exitTimer = undefined;
				this.processAbandoned = true;
				this.finishCleanupAfterExit();
			}, this.abandonExitTimeoutMs);
			this.process.terminate(true);
		}, this.forcedExitTimeoutMs);
	}

	private finishCleanupAfterExit(): void {
		if (this.cleanupStarted || !this.closed || (!this.processExited && !this.processAbandoned)) {
			return;
		}
		this.cleanupStarted = true;
		if (this.exitTimer) {
			this.timers.clearTimeout(this.exitTimer);
			this.exitTimer = undefined;
		}
		this.removeProcessExitListener();
		this.removeProcessErrorListener();
		void this.cleanup().catch(() => undefined).finally(() => this.resolveClosed());
	}
}
