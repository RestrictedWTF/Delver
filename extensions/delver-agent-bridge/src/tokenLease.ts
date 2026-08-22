/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { IDtpTokenAuthenticator } from './connection';

const DEFAULT_LEASE_TTL_MS = 15_000;
const TOKEN_BYTES = 32;
const MAX_ENDPOINT_GENERATION_LENGTH = 128;

export interface IDtpTokenLease {
	readonly leaseId: string;
	readonly endpointGeneration: string;
	readonly token: string;
	readonly expiresAt: number;
}

export type DtpTokenLeaseInvalidationReason = 'expired' | 'revoked' | 'endpointClosed' | 'disposed';

export type DtpTokenLeaseEvent = {
	readonly type: 'issued' | 'consumed';
	readonly leaseId: string;
} | {
	readonly type: 'invalidated';
	readonly leaseId: string;
	readonly reason: DtpTokenLeaseInvalidationReason;
};

export interface ITokenLeaseTimers {
	setTimeout(listener: () => void, delay: number): object;
	clearTimeout(timer: object): void;
}

export interface IDtpTokenLeaseStoreOptions {
	readonly ttlMs?: number;
	readonly now?: () => number;
	readonly createTokenBytes?: (size: number) => Buffer;
	readonly createLeaseId?: () => string;
	readonly timers?: ITokenLeaseTimers;
}

interface IActiveLease extends IDtpTokenLease {
	readonly expirationTimer: object;
	readonly onInvalidated: () => void;
}

const defaultTimers: ITokenLeaseTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Maintains at most one unconsumed, memory-only DTP credential lease. */
export class DtpTokenLeaseStore {
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly createTokenBytes: (size: number) => Buffer;
	private readonly createLeaseId: () => string;
	private readonly timers: ITokenLeaseTimers;
	private readonly listeners = new Set<(event: DtpTokenLeaseEvent) => void>();
	private activeLease: IActiveLease | undefined;
	private disposed = false;

	constructor(options: IDtpTokenLeaseStoreOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
		this.now = options.now ?? Date.now;
		this.createTokenBytes = options.createTokenBytes ?? randomBytes;
		this.createLeaseId = options.createLeaseId ?? randomUUID;
		this.timers = options.timers ?? defaultTimers;
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 60_000) {
			throw new Error('A DTP token lease TTL must be between 1 and 60000 milliseconds.');
		}
	}

	issue(endpointGeneration: string, onInvalidated: () => void = () => { }): IDtpTokenLease {
		this.assertUsable();
		validateEndpointGeneration(endpointGeneration);
		this.expireIfNeeded();
		if (this.activeLease) {
			throw new Error('A DTP token lease is already awaiting consumption.');
		}

		const tokenBytes = this.createTokenBytes(TOKEN_BYTES);
		if (tokenBytes.length !== TOKEN_BYTES) {
			throw new Error('The DTP token generator did not return 256 bits.');
		}
		const leaseId = this.createLeaseId();
		if (typeof leaseId !== 'string' || leaseId.length === 0 || leaseId.length > 128) {
			throw new Error('The DTP token lease id is invalid.');
		}
		const expiresAt = this.now() + this.ttlMs;
		const expirationTimer = this.timers.setTimeout(() => {
			if (this.activeLease?.leaseId === leaseId) {
				this.clearActiveLease('invalidated', 'expired');
			}
		}, this.ttlMs);
		this.activeLease = {
			leaseId,
			endpointGeneration,
			token: tokenBytes.toString('base64url'),
			expiresAt,
			expirationTimer,
			onInvalidated,
		};
		this.emit({ type: 'issued', leaseId });
		return publicLease(this.activeLease);
	}

	consume(token: string, endpointGeneration: string): boolean {
		if (this.disposed || typeof token !== 'string') {
			return false;
		}
		this.expireIfNeeded();
		const lease = this.activeLease;
		if (!lease || lease.endpointGeneration !== endpointGeneration || !tokensEqual(lease.token, token)) {
			return false;
		}
		this.clearActiveLease('consumed');
		return true;
	}

	revoke(leaseId: string, reason: DtpTokenLeaseInvalidationReason = 'revoked'): boolean {
		if (!this.activeLease || this.activeLease.leaseId !== leaseId) {
			return false;
		}
		this.clearActiveLease('invalidated', reason);
		return true;
	}

	/** Observes the terminal state of each issued lease without exposing its token. */
	onDidChange(listener: (event: DtpTokenLeaseEvent) => void): () => void {
		if (this.disposed) {
			return () => { };
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	hasActiveLease(): boolean {
		return !this.disposed && this.activeLease !== undefined;
	}

	revokeActive(reason: DtpTokenLeaseInvalidationReason = 'revoked'): boolean {
		if (!this.activeLease) {
			return false;
		}
		this.clearActiveLease('invalidated', reason);
		return true;
	}

	authenticator(endpointGeneration: string): IDtpTokenAuthenticator {
		validateEndpointGeneration(endpointGeneration);
		return {
			consume: token => this.consume(token, endpointGeneration),
		};
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearActiveLease('invalidated', 'disposed');
		this.listeners.clear();
	}

	private assertUsable(): void {
		if (this.disposed) {
			throw new Error('The DTP token lease store is disposed.');
		}
	}

	private expireIfNeeded(): void {
		if (this.activeLease && this.now() >= this.activeLease.expiresAt) {
			this.clearActiveLease('invalidated', 'expired');
		}
	}

	private clearActiveLease(outcome: 'consumed' | 'invalidated', reason?: DtpTokenLeaseInvalidationReason): void {
		if (!this.activeLease) {
			return;
		}
		const lease = this.activeLease;
		this.timers.clearTimeout(lease.expirationTimer);
		this.activeLease = undefined;
		if (outcome === 'invalidated') {
			try {
				lease.onInvalidated();
			} catch {
				// Lease revocation must remain deterministic even if cleanup fails.
			}
		}
		this.emit(outcome === 'consumed'
			? { type: 'consumed', leaseId: lease.leaseId }
			: { type: 'invalidated', leaseId: lease.leaseId, reason: reason! });
	}

	private emit(event: DtpTokenLeaseEvent): void {
		const frozen = Object.freeze(event);
		for (const listener of [...this.listeners]) {
			try {
				listener(frozen);
			} catch {
				// An observer cannot alter the atomic lease transition.
			}
		}
	}
}

function publicLease(lease: IActiveLease): IDtpTokenLease {
	return {
		leaseId: lease.leaseId,
		endpointGeneration: lease.endpointGeneration,
		token: lease.token,
		expiresAt: lease.expiresAt,
	};
}

function validateEndpointGeneration(endpointGeneration: string): void {
	if (typeof endpointGeneration !== 'string' || endpointGeneration.length === 0 || endpointGeneration.length > MAX_ENDPOINT_GENERATION_LENGTH) {
		throw new Error('The DTP endpoint generation is invalid.');
	}
}

function tokensEqual(expected: string, actual: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const actualBytes = Buffer.from(actual, 'utf8');
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
