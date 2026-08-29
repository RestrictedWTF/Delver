/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BootstrapSessionCloseReason, IBootstrapPeerIdentity } from './bootstrap';
import { GatedBootstrapRelayTransport } from './bootstrapRelayTransport';
import { IBootstrapRelayAttempt, IRelayProcess, parseRelayPeerRecord, RelayProcessFactory } from './relayProcess';
import { IRelayTimers, isRelayReadyRecord } from './relaySupervisor';

const CONTROL_MAX_LINE_BYTES = 4 * 1024;
const CONTROL_MAX_TOTAL_BYTES = 8 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PEER_TIMEOUT_MS = 30_000;

export interface IBootstrapRelayPublicationEntry {
	readonly endpoint: string;
	readonly expiresAt: number;
}

export interface IBootstrapRelayPublication {
	dispose(): Promise<void>;
}

interface IManagedBootstrapSession {
	dispose(closeTransport?: boolean): void;
	whenClosed(): Promise<BootstrapSessionCloseReason>;
}

export type BootstrapRelayCloseReason = 'idleTimeout' | 'readinessFailure' | 'controlViolation' | 'publicationFailure' | 'transportFailure' | BootstrapSessionCloseReason;

export interface IDelverBootstrapRelayManagerOptions {
	readonly executable: string;
	readonly spawn: RelayProcessFactory;
	readonly createAttempt: () => IBootstrapRelayAttempt;
	readonly publish: (entry: IBootstrapRelayPublicationEntry) => IBootstrapRelayPublication | Promise<IBootstrapRelayPublication>;
	readonly createSession: (transport: GatedBootstrapRelayTransport, peer: IBootstrapPeerIdentity) => IManagedBootstrapSession;
	readonly platform?: NodeJS.Platform;
	readonly timers?: IRelayTimers;
	readonly readinessTimeoutMs?: number;
	readonly peerTimeoutMs?: number;
	readonly maxBufferedInputBytes?: number;
	readonly now?: () => number;
}

type BootstrapRelayState = 'idle' | 'starting' | 'awaitingReady' | 'armed' | 'published' | 'serving' | 'closing' | 'closed';

const defaultTimers: IRelayTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Owns one unpublished-to-one-shot bootstrap relay attempt without restart policy. */
export class DelverBootstrapRelayManager {
	private readonly timers: IRelayTimers;
	private readonly readinessTimeoutMs: number;
	private readonly peerTimeoutMs: number;
	private readonly now: () => number;
	private readonly completionPromise: Promise<BootstrapRelayCloseReason>;
	private resolveCompletion!: (reason: BootstrapRelayCloseReason) => void;
	private state: BootstrapRelayState = 'idle';
	private attempt: IBootstrapRelayAttempt | undefined;
	private relayProcess: IRelayProcess | undefined;
	private transport: GatedBootstrapRelayTransport | undefined;
	private session: IManagedBootstrapSession | undefined;
	private publication: IBootstrapRelayPublication | undefined;
	private publicationPromise: Promise<IBootstrapRelayPublication> | undefined;
	private publicationDisposePromise: Promise<void> | undefined;
	private publicationConsumed = false;
	private pendingPeer: IBootstrapPeerIdentity | undefined;
	private removeControlListener: (() => void) | undefined;
	private removeTransportCloseListener: (() => void) | undefined;
	private readyTimer: object | undefined;
	private peerTimer: object | undefined;
	private controlBuffer = Buffer.alloc(0);
	private controlBytes = 0;
	private controlRecords = 0;
	private startPromise: Promise<void> | undefined;
	private resolveStart: (() => void) | undefined;
	private rejectStart: ((error: Error) => void) | undefined;
	private startSettled = false;

	constructor(private readonly options: IDelverBootstrapRelayManagerOptions) {
		this.timers = options.timers ?? defaultTimers;
		this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		this.peerTimeoutMs = options.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		validateTimeout(this.readinessTimeoutMs, 'readiness');
		validateTimeout(this.peerTimeoutMs, 'peer');
		this.completionPromise = new Promise(resolve => this.resolveCompletion = resolve);
	}

	start(): Promise<void> {
		if (this.state !== 'idle') {
			return this.startPromise ?? Promise.reject(new Error('The Delver bootstrap relay manager cannot be restarted.'));
		}
		this.state = 'starting';
		this.startPromise = new Promise<void>((resolve, reject) => {
			this.resolveStart = resolve;
			this.rejectStart = reject;
		});

		try {
			this.attempt = this.options.createAttempt();
			// The child is owned from the moment it exists: every later failure in
			// this block must be able to kill it, transport or no transport.
			const relayProcess = this.options.spawn(this.options.executable, this.attempt.endpoint);
			this.relayProcess = relayProcess;
			this.transport = new GatedBootstrapRelayTransport(relayProcess, this.options.maxBufferedInputBytes);
			this.state = 'awaitingReady';
			this.removeControlListener = relayProcess.onStderr(data => this.receiveControl(data));
			this.removeTransportCloseListener = this.transport.onClose(() => {
				if (!this.session) {
					this.finish('transportFailure', new Error('The Delver bootstrap relay closed.'), false);
				}
			});
			this.readyTimer = this.timers.setTimeout(
				() => this.finish('readinessFailure', new Error('The Delver bootstrap relay readiness timed out.'), true),
				this.readinessTimeoutMs,
			);
		} catch {
			this.finish('transportFailure', new Error('The Delver bootstrap relay could not be started.'), true);
		}
		return this.startPromise;
	}

	whenClosed(): Promise<BootstrapRelayCloseReason> {
		return this.completionPromise;
	}

	dispose(): void {
		this.finish('disposed', new Error('The Delver bootstrap relay manager was disposed.'), true);
	}

	private receiveControl(data: Buffer): void {
		if (this.isClosingOrClosed()) {
			return;
		}
		if (data.length > CONTROL_MAX_TOTAL_BYTES - this.controlBytes) {
			this.finish('controlViolation', new Error('The Delver bootstrap relay control stream is too large.'), true);
			return;
		}
		this.controlBytes += data.length;
		this.controlBuffer = Buffer.concat([this.controlBuffer, data]);

		while (!this.isClosingOrClosed()) {
			const newline = this.controlBuffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.controlBuffer.length > CONTROL_MAX_LINE_BYTES) {
					this.finish('controlViolation', new Error('The Delver bootstrap relay control record is too large.'), true);
				}
				return;
			}
			if (newline > CONTROL_MAX_LINE_BYTES) {
				this.finish('controlViolation', new Error('The Delver bootstrap relay control record is too large.'), true);
				return;
			}
			let line = this.controlBuffer.subarray(0, newline);
			this.controlBuffer = this.controlBuffer.subarray(newline + 1);
			if (line.at(-1) === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			this.receiveControlRecord(line);
		}
	}

	private receiveControlRecord(line: Buffer): void {
		let value: unknown;
		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
			value = JSON.parse(text);
		} catch {
			this.finish('controlViolation', new Error('The Delver bootstrap relay control record is invalid.'), true);
			return;
		}

		if (this.controlRecords === 0) {
			if (this.state !== 'awaitingReady' || !isRelayReadyRecord(value)) {
				this.finish('readinessFailure', new Error('The Delver bootstrap relay readiness record is invalid.'), true);
				return;
			}
			this.controlRecords++;
			this.handleReady();
			return;
		}
		if (this.controlRecords === 1) {
			if (this.state !== 'published') {
				this.finish('controlViolation', new Error('The Delver bootstrap relay reported a peer before publication.'), true);
				return;
			}
			let peer: IBootstrapPeerIdentity;
			try {
				peer = parseRelayPeerRecord(value, this.options.platform ?? process.platform);
			} catch {
				this.finish('controlViolation', new Error('The Delver bootstrap relay peer record is invalid.'), true);
				return;
			}
			this.controlRecords++;
			this.handlePeer(peer);
			return;
		}
		this.finish('controlViolation', new Error('The Delver bootstrap relay emitted unexpected control data.'), true);
	}

	private handleReady(): void {
		this.clearReadyTimer();
		this.state = 'armed';
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.peerTimeoutMs) {
			this.finish('transportFailure', new Error('The Delver bootstrap relay clock is invalid.'), true);
			return;
		}
		const expiresAt = now + this.peerTimeoutMs;
		this.peerTimer = this.timers.setTimeout(
			() => this.finish('idleTimeout', new Error('The Delver bootstrap relay peer attestation timed out.'), true),
			this.peerTimeoutMs,
		);
		this.state = 'published';
		try {
			this.publicationPromise = Promise.resolve(this.options.publish(Object.freeze({ endpoint: this.attempt!.endpoint, expiresAt })));
		} catch {
			this.finish('publicationFailure', new Error('The Delver bootstrap endpoint could not be published.'), true);
			return;
		}
		void this.acceptPublication(this.publicationPromise);
	}

	private async acceptPublication(promise: Promise<IBootstrapRelayPublication>): Promise<void> {
		let publication: IBootstrapRelayPublication;
		try {
			publication = await promise;
		} catch {
			if (!this.isClosingOrClosed()) {
				this.finish('publicationFailure', new Error('The Delver bootstrap endpoint could not be published.'), true);
			}
			return;
		}
		if (this.isClosingOrClosed() || this.publicationConsumed) {
			try {
				await this.disposePublication(publication);
			} catch {
				// The first close reason remains authoritative during late cleanup.
			}
			return;
		}
		this.publication = publication;
		this.resolveStarted();
		if (this.pendingPeer) {
			void this.servePeer(this.pendingPeer);
		}
	}

	private handlePeer(peer: IBootstrapPeerIdentity): void {
		this.pendingPeer = peer;
		if (this.publication) {
			void this.servePeer(peer);
		}
	}

	private async servePeer(peer: IBootstrapPeerIdentity): Promise<void> {
		if (this.state !== 'published' || !this.publication) {
			return;
		}
		this.clearPeerTimer();
		this.state = 'serving';
		this.pendingPeer = undefined;
		this.publicationConsumed = true;
		const publication = this.publication;
		this.publication = undefined;
		try {
			await this.disposePublication(publication);
		} catch {
			this.finish('publicationFailure', new Error('The Delver bootstrap endpoint could not be unpublished.'), true);
			return;
		}
		if (this.state !== 'serving') {
			return;
		}
		try {
			const session = this.options.createSession(this.transport!, peer);
			this.session = session;
			this.removeTransportCloseListener?.();
			this.removeTransportCloseListener = undefined;
			void session.whenClosed().then(
				reason => this.finish(reason, new Error('The Delver bootstrap session closed.'), false),
				() => this.finish('internalFailure', new Error('The Delver bootstrap session failed.'), true),
			);
			this.transport!.release();
		} catch {
			this.finish('internalFailure', new Error('The Delver bootstrap session could not be created.'), true);
		}
	}

	private finish(reason: BootstrapRelayCloseReason, error: Error, terminate: boolean): void {
		if (this.state === 'closing' || this.state === 'closed') {
			return;
		}
		this.state = 'closing';
		this.clearReadyTimer();
		this.clearPeerTimer();
		this.removeControlListener?.();
		this.removeControlListener = undefined;
		this.removeTransportCloseListener?.();
		this.removeTransportCloseListener = undefined;
		this.publicationConsumed = true;
		this.pendingPeer = undefined;
		this.session?.dispose(false);
		this.session = undefined;
		if (terminate) {
			// The transport terminates the child it wraps; without one, only the
			// manager holds the spawned child and must kill it directly.
			if (this.transport) {
				this.transport.terminate();
			} else {
				this.relayProcess?.terminate();
			}
		}
		this.relayProcess = undefined;
		this.rejectStarted(error);
		void this.finishCleanup(reason);
	}

	private async finishCleanup(reason: BootstrapRelayCloseReason): Promise<void> {
		if (this.publicationPromise) {
			try {
				const publication = await this.publicationPromise;
				await this.disposePublication(publication);
			} catch {
				// Failure is already represented by the first close reason.
			}
		}
		const attempt = this.attempt;
		this.attempt = undefined;
		try {
			await attempt?.cleanup();
		} catch {
			// Endpoint cleanup failure cannot resurrect this generation.
		}
		this.state = 'closed';
		this.resolveCompletion(reason);
	}

	private disposePublication(publication: IBootstrapRelayPublication): Promise<void> {
		if (!this.publicationDisposePromise) {
			try {
				this.publicationDisposePromise = Promise.resolve(publication.dispose());
			} catch (error) {
				this.publicationDisposePromise = Promise.reject(error);
			}
		}
		return this.publicationDisposePromise;
	}

	private resolveStarted(): void {
		if (this.startSettled) {
			return;
		}
		this.startSettled = true;
		this.resolveStart?.();
		this.resolveStart = undefined;
		this.rejectStart = undefined;
	}

	private rejectStarted(error: Error): void {
		if (this.startSettled) {
			return;
		}
		this.startSettled = true;
		this.rejectStart?.(error);
		this.resolveStart = undefined;
		this.rejectStart = undefined;
	}

	private clearReadyTimer(): void {
		if (this.readyTimer) {
			this.timers.clearTimeout(this.readyTimer);
			this.readyTimer = undefined;
		}
	}

	private clearPeerTimer(): void {
		if (this.peerTimer) {
			this.timers.clearTimeout(this.peerTimer);
			this.peerTimer = undefined;
		}
	}

	private isClosingOrClosed(): boolean {
		return this.state === 'closing' || this.state === 'closed';
	}
}

function validateTimeout(timeout: number, name: string): void {
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
		throw new Error(`The Delver bootstrap relay ${name} timeout is invalid.`);
	}
}
