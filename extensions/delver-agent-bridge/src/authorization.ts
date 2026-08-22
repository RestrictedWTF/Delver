/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { IBootstrapClaim, IBootstrapPeerIdentity } from './bootstrap';

const DEFAULT_AUTHORIZATION_TTL_MS = 30_000;
const AUTHORIZATION_REQUEST_BYTES = 16;

export interface IBootstrapAuthorizationPeer {
	readonly platform: NodeJS.Platform;
	readonly processId?: number;
	readonly userId?: number;
}

export interface IBootstrapAuthorizationRequest {
	readonly authorizationRequestId: string;
	readonly peer: IBootstrapAuthorizationPeer;
	readonly registryEntryId: string;
	readonly windowInstanceId: string;
	readonly rootFingerprint: string;
	readonly untrustedDisplayName?: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface IBootstrapAuthorizationTimers {
	setTimeout(listener: () => void, delay: number): object;
	clearTimeout(timer: object): void;
}

export interface IInMemoryBootstrapAuthorizerOptions {
	readonly ttlMs?: number;
	readonly now?: () => number;
	readonly createRequestId?: () => string;
	readonly getCurrentUserId?: () => number | undefined;
	readonly timers?: IBootstrapAuthorizationTimers;
}

interface IPendingAuthorization {
	readonly request: IBootstrapAuthorizationRequest;
	readonly lifecycle: AbortController;
	readonly expirationTimer: object;
	readonly removeAbortListener: () => void;
	readonly resolve: (result: BootstrapAuthorizationResult) => void;
}

export type BootstrapAuthorizationResult = 'granted' | 'denied' | 'expired' | 'cancelled' | 'busy' | 'unavailable' | 'unsupportedPeer';

export type BootstrapAuthorizationRequestListener = (request: IBootstrapAuthorizationRequest, signal: AbortSignal) => void;

const defaultTimers: IBootstrapAuthorizationTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Holds one connection-bound authorization request without creating a reusable identity allowlist. */
export class InMemoryBootstrapAuthorizer {
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly createRequestId: () => string;
	private readonly getCurrentUserId: () => number | undefined;
	private readonly timers: IBootstrapAuthorizationTimers;
	private readonly listeners = new Set<BootstrapAuthorizationRequestListener>();
	private readonly usedRequestIds = new Set<string>();
	private pending: IPendingAuthorization | undefined;
	private disposed = false;

	constructor(options: IInMemoryBootstrapAuthorizerOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
		this.now = options.now ?? Date.now;
		this.createRequestId = options.createRequestId ?? (() => randomBytes(AUTHORIZATION_REQUEST_BYTES).toString('base64url'));
		this.getCurrentUserId = options.getCurrentUserId ?? currentEffectiveUserId;
		this.timers = options.timers ?? defaultTimers;
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 300_000) {
			throw new Error('A bootstrap authorization TTL must be between 1 and 300000 milliseconds.');
		}
	}

	/** Registers the trusted UI/controller that may grant or deny a pending request. */
	onDidRequest(listener: BootstrapAuthorizationRequestListener): () => void {
		if (this.disposed) {
			return () => { };
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Requests a one-shot grant for the currently connected and OS-attested bootstrap peer. */
	authorize(peer: IBootstrapPeerIdentity, claim: IBootstrapClaim, signal: AbortSignal): Promise<BootstrapAuthorizationResult> {
		if (this.disposed || signal.aborted) {
			return Promise.resolve('cancelled');
		}
		if (this.pending) {
			return Promise.resolve('busy');
		}
		if (this.listeners.size === 0) {
			return Promise.resolve('unavailable');
		}
		if (!this.isSupportedPeer(peer)) {
			return Promise.resolve('unsupportedPeer');
		}

		const authorizationRequestId = this.createRequestId();
		if (!isBoundedRequestId(authorizationRequestId) || this.usedRequestIds.has(authorizationRequestId)) {
			return Promise.resolve('unavailable');
		}
		const createdAt = this.now();
		if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > Number.MAX_SAFE_INTEGER - this.ttlMs) {
			return Promise.resolve('unavailable');
		}
		this.usedRequestIds.add(authorizationRequestId);

		return new Promise<BootstrapAuthorizationResult>(resolve => {
			const lifecycle = new AbortController();
			const request = Object.freeze({
				authorizationRequestId,
				peer: Object.freeze({
					platform: peer.platform,
					...(peer.processId === undefined ? {} : { processId: peer.processId }),
					...(peer.userId === undefined ? {} : { userId: peer.userId }),
				}),
				registryEntryId: claim.registryEntryId,
				windowInstanceId: claim.windowInstanceId,
				rootFingerprint: claim.rootFingerprint,
				...(claim.displayName === undefined ? {} : { untrustedDisplayName: claim.displayName }),
				createdAt,
				expiresAt: createdAt + this.ttlMs,
			});
			const handleAbort = () => this.finish(authorizationRequestId, 'cancelled');
			signal.addEventListener('abort', handleAbort, { once: true });
			const expirationTimer = this.timers.setTimeout(() => this.finish(authorizationRequestId, 'expired'), this.ttlMs);
			this.pending = {
				request,
				lifecycle,
				expirationTimer,
				removeAbortListener: () => signal.removeEventListener('abort', handleAbort),
				resolve,
			};

			for (const listener of [...this.listeners]) {
				if (!this.pending) {
					break;
				}
				try {
					listener(request, lifecycle.signal);
				} catch {
					// A failing observer cannot grant or strand the pending request.
				}
			}
		});
	}

	/** Consumes the exact pending grant once. */
	grantOnce(authorizationRequestId: string): boolean {
		return this.finish(authorizationRequestId, 'granted');
	}

	/** Denies the exact pending request once. */
	deny(authorizationRequestId: string): boolean {
		return this.finish(authorizationRequestId, 'denied');
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.pending) {
			this.finish(this.pending.request.authorizationRequestId, 'cancelled');
		}
		this.listeners.clear();
	}

	private finish(authorizationRequestId: string, result: BootstrapAuthorizationResult): boolean {
		const pending = this.pending;
		if (!pending || pending.request.authorizationRequestId !== authorizationRequestId) {
			return false;
		}
		this.pending = undefined;
		this.timers.clearTimeout(pending.expirationTimer);
		pending.removeAbortListener();
		pending.lifecycle.abort();
		pending.resolve(result);
		return true;
	}

	private isSupportedPeer(peer: IBootstrapPeerIdentity): boolean {
		const validProcessId = Number.isSafeInteger(peer.processId) && (peer.processId ?? 0) > 0;
		const validUserId = Number.isSafeInteger(peer.userId) && (peer.userId ?? -1) >= 0;
		if (peer.platform === 'win32') {
			return validProcessId && peer.userId === undefined;
		}

		const currentUserId = this.getCurrentUserId();
		if (!Number.isSafeInteger(currentUserId) || (currentUserId ?? -1) < 0 || !validUserId || peer.userId !== currentUserId) {
			return false;
		}
		if (peer.platform === 'linux' || peer.platform === 'android') {
			return validProcessId;
		}
		return (peer.platform === 'darwin' || peer.platform === 'freebsd' || peer.platform === 'openbsd') && peer.processId === undefined;
	}
}

function currentEffectiveUserId(): number | undefined {
	return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function isBoundedRequestId(value: string): boolean {
	return typeof value === 'string' && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
