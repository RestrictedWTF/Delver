/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BootstrapRelayCloseReason, IBootstrapRelayPublication, IBootstrapRelayPublicationEntry } from './bootstrapRelayManager';
import { DtpTokenLeaseEvent, DtpTokenLeaseStore } from './tokenLease';
import { IRendezvousRegistry, RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION, RENDEZVOUS_SCHEMA_VERSION } from './rendezvousRegistry';

const ROOT_FINGERPRINT = /^[0-9a-f]{64}$/;
const GENERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_IDLE_DELAY_MS = 250;
const DEFAULT_TECHNICAL_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
const DEFAULT_PROMPT_DELAYS_MS = [30_000, 120_000, 300_000] as const;

export interface IRendezvousApprovalBusyGate {
	isBusy(): boolean;
	onDidChangeBusy(listener: (busy: boolean) => void): () => void;
}

export interface IRendezvousLifecycleManager {
	start(): Promise<void>;
	whenClosed(): Promise<BootstrapRelayCloseReason>;
	dispose(): void;
}

export interface IRendezvousLifecycleManagerContext {
	readonly registryEntryId: string;
	readonly windowInstanceId: string;
	readonly rootFingerprint: string;
	readonly publish: (entry: IBootstrapRelayPublicationEntry) => Promise<IBootstrapRelayPublication>;
}

export interface IRendezvousLifecycleTimers {
	setTimeout(listener: () => void, delay: number): object;
	clearTimeout(timer: object): void;
}

export interface IDelverWindowRendezvousLifecycleOptions {
	readonly registry: IRendezvousRegistry;
	readonly leases: DtpTokenLeaseStore;
	readonly approvalBusyGate: IRendezvousApprovalBusyGate;
	readonly createManager: (context: IRendezvousLifecycleManagerContext) => IRendezvousLifecycleManager;
	readonly createWindowInstanceId: () => string;
	readonly createRegistryEntryId: () => string;
	readonly ownerProcessId: number;
	readonly now?: () => number;
	readonly timers?: IRendezvousLifecycleTimers;
	readonly random?: () => number;
	readonly idleDelayMs?: number;
	readonly technicalDelaysMs?: readonly number[];
	readonly promptDelaysMs?: readonly number[];
}

const defaultTimers: IRendezvousLifecycleTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Owns one inactive-window rendezvous generation and its bounded restart policy. */
export class DelverWindowRendezvousLifecycle {
	private readonly now: () => number;
	private readonly timers: IRendezvousLifecycleTimers;
	private readonly random: () => number;
	private readonly idleDelayMs: number;
	private readonly technicalDelaysMs: readonly number[];
	private readonly promptDelaysMs: readonly number[];
	private readonly removeLeaseListener: () => void;
	private readonly removeBusyListener: () => void;
	private readonly disposalPromise: Promise<void>;
	private resolveDisposal!: () => void;
	private rootFingerprint: string | undefined;
	private windowInstanceId: string | undefined;
	private manager: IRendezvousLifecycleManager | undefined;
	private restartTimer: object | undefined;
	private restartKind: 'idle' | 'technical' | 'prompt' | undefined;
	private epoch = 0;
	private technicalFailures = 0;
	private promptFailures = 0;
	private started = false;
	private disposed = false;
	private suppressLeaseEvents = false;
	private pendingLeaseEvent: DtpTokenLeaseEvent | undefined;
	private readonly teardowns = new Set<Promise<BootstrapRelayCloseReason>>();

	constructor(private readonly options: IDelverWindowRendezvousLifecycleOptions) {
		if (!Number.isSafeInteger(options.ownerProcessId) || options.ownerProcessId < 1) {
			throw new Error('The Delver rendezvous owner process id is invalid.');
		}
		this.now = options.now ?? Date.now;
		this.timers = options.timers ?? defaultTimers;
		this.random = options.random ?? Math.random;
		this.idleDelayMs = validateDelay(options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS);
		this.technicalDelaysMs = validateDelays(options.technicalDelaysMs ?? DEFAULT_TECHNICAL_DELAYS_MS);
		this.promptDelaysMs = validateDelays(options.promptDelaysMs ?? DEFAULT_PROMPT_DELAYS_MS);
		this.disposalPromise = new Promise(resolve => this.resolveDisposal = resolve);
		this.removeLeaseListener = options.leases.onDidChange(event => this.handleLeaseEvent(event));
		this.removeBusyListener = options.approvalBusyGate.onDidChangeBusy(busy => {
			if (!busy) {
				this.maybeStart();
			}
		});
	}

	start(): void {
		if (this.disposed) {
			throw new Error('The Delver rendezvous lifecycle is disposed.');
		}
		if (this.started) {
			return;
		}
		this.started = true;
		this.maybeStart();
	}

	setRoot(rootFingerprint: string | undefined): void {
		if (this.disposed) {
			return;
		}
		if (rootFingerprint !== undefined && !ROOT_FINGERPRINT.test(rootFingerprint)) {
			throw new Error('The Delver rendezvous root fingerprint is invalid.');
		}
		if (rootFingerprint === this.rootFingerprint) {
			return;
		}
		const windowInstanceId = rootFingerprint === undefined ? undefined : this.createGenerationId(this.options.createWindowInstanceId, 'window');
		this.epoch++;
		this.rootFingerprint = rootFingerprint;
		this.windowInstanceId = windowInstanceId;
		this.technicalFailures = 0;
		this.promptFailures = 0;
		this.pendingLeaseEvent = undefined;
		this.clearRestartTimer();
		this.suppressLeaseEvents = true;
		this.options.leases.revokeActive('revoked');
		this.suppressLeaseEvents = false;
		this.teardownManager();
		this.maybeStart();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.epoch++;
		this.clearRestartTimer();
		this.removeBusyListener();
		this.removeLeaseListener();
		this.suppressLeaseEvents = true;
		this.options.leases.revokeActive('disposed');
		this.suppressLeaseEvents = false;
		this.teardownManager();
		void this.finishDisposal();
	}

	whenDisposed(): Promise<void> {
		return this.disposalPromise;
	}

	private maybeStart(): void {
		if (!this.started || this.disposed || !this.rootFingerprint || !this.windowInstanceId || this.manager || this.restartTimer || this.teardowns.size > 0 || this.options.leases.hasActiveLease() || this.options.approvalBusyGate.isBusy()) {
			return;
		}
		const epoch = this.epoch;
		let registryEntryId: string;
		try {
			registryEntryId = this.createGenerationId(this.options.createRegistryEntryId, 'registry');
		} catch {
			this.schedule('technical');
			return;
		}
		const windowInstanceId = this.windowInstanceId;
		const rootFingerprint = this.rootFingerprint;
		const context: IRendezvousLifecycleManagerContext = Object.freeze({
			registryEntryId,
			windowInstanceId,
			rootFingerprint,
			publish: (entry: IBootstrapRelayPublicationEntry) => this.publish(contextIdentity(registryEntryId, windowInstanceId, rootFingerprint), entry),
		});
		let manager: IRendezvousLifecycleManager;
		try {
			manager = this.options.createManager(context);
		} catch {
			this.schedule('technical');
			return;
		}
		this.manager = manager;
		try {
			void manager.start().catch(() => undefined);
		} catch {
			manager.dispose();
		}
		void manager.whenClosed().then(reason => this.managerClosed(manager, epoch, reason), () => this.managerClosed(manager, epoch, 'internalFailure'));
	}

	private async publish(identity: { readonly registryEntryId: string; readonly windowInstanceId: string; readonly rootFingerprint: string }, entry: IBootstrapRelayPublicationEntry): Promise<IBootstrapRelayPublication> {
		const publishedAt = this.now();
		const publication = await this.options.registry.publish({
			schemaVersion: RENDEZVOUS_SCHEMA_VERSION,
			bootstrapProtocolVersion: RENDEZVOUS_BOOTSTRAP_PROTOCOL_VERSION,
			...identity,
			bootstrapEndpoint: entry.endpoint,
			ownerProcessId: this.options.ownerProcessId,
			publishedAt,
			expiresAt: entry.expiresAt,
		});
		return publication;
	}

	private managerClosed(manager: IRendezvousLifecycleManager, epoch: number, reason: BootstrapRelayCloseReason): void {
		if (this.manager !== manager) {
			return;
		}
		this.manager = undefined;
		if (this.disposed || epoch !== this.epoch) {
			this.pendingLeaseEvent = undefined;
			this.maybeStart();
			return;
		}
		const leaseEvent = this.pendingLeaseEvent;
		this.pendingLeaseEvent = undefined;
		if (leaseEvent) {
			this.applyLeaseEvent(leaseEvent);
			return;
		}
		if (reason === 'credentialIssued') {
			if (this.options.leases.hasActiveLease()) {
				return;
			}
			this.schedule('technical');
			return;
		}
		if (reason === 'idleTimeout') {
			this.schedule('idle');
		} else if (reason === 'authorizationDenied' || reason === 'authorizationExpired' || reason === 'authorizationBusy') {
			this.schedule('prompt');
		} else if (reason !== 'disposed') {
			this.schedule('technical');
		}
	}

	private handleLeaseEvent(event: DtpTokenLeaseEvent): void {
		if (this.disposed || this.suppressLeaseEvents || event.type === 'issued') {
			return;
		}
		if (this.manager) {
			this.pendingLeaseEvent = event;
			return;
		}
		this.applyLeaseEvent(event);
	}

	private applyLeaseEvent(event: DtpTokenLeaseEvent): void {
		if (event.type === 'consumed') {
			this.technicalFailures = 0;
			this.promptFailures = 0;
			this.clearRestartTimer();
			this.schedule('idle');
		} else if (event.type === 'invalidated') {
			this.schedule('prompt');
		}
	}

	private schedule(kind: 'idle' | 'technical' | 'prompt'): void {
		if (this.disposed) {
			return;
		}
		if (this.restartTimer) {
			if (kind !== 'prompt' || this.restartKind === 'prompt') {
				return;
			}
			this.clearRestartTimer();
		}
		let baseDelay: number;
		if (kind === 'idle') {
			baseDelay = this.idleDelayMs;
		} else if (kind === 'technical') {
			baseDelay = this.technicalDelaysMs[Math.min(this.technicalFailures++, this.technicalDelaysMs.length - 1)];
		} else {
			baseDelay = this.promptDelaysMs[Math.min(this.promptFailures++, this.promptDelaysMs.length - 1)];
		}
		let delay: number;
		try {
			delay = jitterDelay(baseDelay, this.random());
		} catch {
			return;
		}
		const epoch = this.epoch;
		this.restartKind = kind;
		this.restartTimer = this.timers.setTimeout(() => {
			this.restartTimer = undefined;
			this.restartKind = undefined;
			if (epoch === this.epoch) {
				this.maybeStart();
			}
		}, delay);
	}

	private teardownManager(): void {
		const manager = this.manager;
		if (!manager) {
			return;
		}
		this.manager = undefined;
		manager.dispose();
		const teardown = manager.whenClosed();
		this.teardowns.add(teardown);
		void teardown.catch(() => 'internalFailure' as const).finally(() => {
			this.teardowns.delete(teardown);
			this.maybeStart();
		});
	}

	private async finishDisposal(): Promise<void> {
		while (this.teardowns.size > 0) {
			await Promise.all([...this.teardowns].map(teardown => teardown.catch(() => undefined)));
		}
		this.resolveDisposal();
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) {
			this.timers.clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
			this.restartKind = undefined;
		}
	}

	private createGenerationId(factory: () => string, name: string): string {
		const value = factory();
		if (!GENERATION_ID.test(value)) {
			throw new Error(`The Delver rendezvous ${name} generation id is invalid.`);
		}
		return value;
	}
}

function contextIdentity(registryEntryId: string, windowInstanceId: string, rootFingerprint: string) {
	return Object.freeze({ registryEntryId, windowInstanceId, rootFingerprint });
}

function validateDelays(delays: readonly number[]): readonly number[] {
	if (delays.length === 0) {
		throw new Error('A Delver rendezvous backoff sequence cannot be empty.');
	}
	return Object.freeze(delays.map(validateDelay));
}

function validateDelay(delay: number): number {
	if (!Number.isSafeInteger(delay) || delay < 1 || delay > 300_000) {
		throw new Error('A Delver rendezvous backoff delay is invalid.');
	}
	return delay;
}

function jitterDelay(baseDelay: number, random: number): number {
	if (!Number.isFinite(random) || random < 0 || random >= 1) {
		throw new Error('The Delver rendezvous random source is invalid.');
	}
	return Math.max(1, Math.round(baseDelay * (0.8 + random * 0.4)));
}
