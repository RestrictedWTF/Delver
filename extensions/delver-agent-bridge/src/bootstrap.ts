/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DtpFrameDecoder } from './protocol';
import { DtpTokenLeaseStore } from './tokenLease';
import type { BootstrapAuthorizationResult } from './authorization';

const BOOTSTRAP_PROTOCOL_VERSION = 1;
export const BOOTSTRAP_MAX_HEADER_BYTES = 4 * 1024;
export const BOOTSTRAP_MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 128;
const ROOT_FINGERPRINT = /^[0-9a-f]{64}$/;
const CLIENT_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;

export const enum BootstrapErrorCode {
	InvalidRequest = 'INVALID_REQUEST',
	VersionMismatch = 'VERSION_MISMATCH',
	StaleWindow = 'STALE_WINDOW',
	RootMismatch = 'ROOT_MISMATCH',
	Denied = 'DENIED',
	Busy = 'BUSY',
	InternalError = 'INTERNAL_ERROR',
}

export interface IBootstrapPeerIdentity {
	readonly platform: NodeJS.Platform;
	readonly processId?: number;
	readonly userId?: number;
	readonly executable?: string;
}

export interface IBootstrapClaim {
	readonly protocolVersion: 1;
	readonly registryEntryId: string;
	readonly windowInstanceId: string;
	readonly rootFingerprint: string;
	readonly clientNonce: string;
	readonly displayName?: string;
}

export interface IBootstrapProvision {
	readonly endpoint: string;
	readonly endpointGeneration: string;
	onDidClose(listener: () => void): () => void;
	dispose(): void;
}

export interface IBootstrapTransport {
	onData(listener: (data: Buffer) => void): () => void;
	onClose(listener: () => void): () => void;
	write(data: Buffer): Promise<void>;
	close(): void;
}

export interface IDelverBootstrapSessionOptions {
	readonly expectedRegistryEntryId: string;
	readonly expectedWindowInstanceId: string;
	readonly expectedRootFingerprint: string;
	readonly peerIdentity: IBootstrapPeerIdentity;
	readonly authorize?: (peer: IBootstrapPeerIdentity, claim: IBootstrapClaim, signal: AbortSignal) => Promise<BootstrapAuthorizationResult>;
	readonly provisionDtp: (claim: IBootstrapClaim, signal: AbortSignal) => Promise<IBootstrapProvision>;
	readonly leases: DtpTokenLeaseStore;
	readonly claimTimeoutMs?: number;
	readonly timers?: IBootstrapTimers;
}

export interface IBootstrapTimers {
	setTimeout(listener: () => void, delay: number): object;
	clearTimeout(timer: object): void;
}

export type BootstrapSessionCloseReason = 'invalidClaim' | 'claimTimeout' | 'authorizationDenied' | 'authorizationExpired' | 'authorizationBusy' | 'authorizationUnavailable' | 'credentialIssued' | 'clientDisconnected' | 'internalFailure' | 'disposed';

type BootstrapState = 'waiting' | 'validating' | 'authorizing' | 'provisioning' | 'issuing' | 'closed';

interface IBootstrapRequest {
	readonly id: number;
	readonly method: 'bootstrap/claim';
	readonly params: IBootstrapClaim;
}

/** Handles one default-deny credential claim over an owner-only transport. */
export class DelverBootstrapSession {
	private readonly decoder = new DtpFrameDecoder(BOOTSTRAP_MAX_HEADER_BYTES, BOOTSTRAP_MAX_MESSAGE_BYTES);
	private readonly abortController = new AbortController();
	private readonly removeDataListener: () => void;
	private readonly removeCloseListener: () => void;
	private readonly completionPromise: Promise<BootstrapSessionCloseReason>;
	private resolveCompletion!: (reason: BootstrapSessionCloseReason) => void;
	private readonly timers: IBootstrapTimers;
	private readonly claimTimer: object;
	private state: BootstrapState = 'waiting';
	private provision: IBootstrapProvision | undefined;
	private leaseId: string | undefined;

	constructor(
		private readonly transport: IBootstrapTransport,
		private readonly options: IDelverBootstrapSessionOptions,
	) {
		const claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
		if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs < 1 || claimTimeoutMs > 60_000) {
			throw new Error('The bootstrap claim timeout is invalid.');
		}
		this.timers = options.timers ?? defaultBootstrapTimers;
		this.completionPromise = new Promise(resolve => this.resolveCompletion = resolve);
		this.removeDataListener = transport.onData(data => this.receive(data));
		this.removeCloseListener = transport.onClose(() => this.finish('clientDisconnected', false));
		this.claimTimer = this.timers.setTimeout(() => this.finish('claimTimeout', true), claimTimeoutMs);
	}

	dispose(closeTransport = true): void {
		this.finish('disposed', closeTransport);
	}

	whenClosed(): Promise<BootstrapSessionCloseReason> {
		return this.completionPromise;
	}

	private finish(reason: BootstrapSessionCloseReason, closeTransport: boolean): void {
		if (this.state === 'closed') {
			return;
		}
		this.state = 'closed';
		this.timers.clearTimeout(this.claimTimer);
		this.abortController.abort();
		this.removeDataListener();
		this.removeCloseListener();
		if (this.leaseId) {
			this.options.leases.revoke(this.leaseId);
			this.leaseId = undefined;
		} else {
			this.provision?.dispose();
		}
		this.provision = undefined;
		if (closeTransport) {
			this.transport.close();
		}
		this.resolveCompletion(reason);
	}

	private receive(data: Buffer): void {
		if (this.state !== 'waiting') {
			void this.fail(null, BootstrapErrorCode.Busy, 'This bootstrap connection already has a claim.', 'invalidClaim');
			return;
		}
		let frames: readonly Buffer[];
		try {
			frames = this.decoder.push(data);
		} catch {
			void this.fail(null, BootstrapErrorCode.InvalidRequest, 'The bootstrap frame is invalid.', 'invalidClaim');
			return;
		}
		if (frames.length === 0) {
			return;
		}
		if (frames.length !== 1) {
			void this.fail(null, BootstrapErrorCode.Busy, 'Only one bootstrap claim is accepted.', 'invalidClaim');
			return;
		}
		this.timers.clearTimeout(this.claimTimer);
		this.state = 'validating';
		let request: IBootstrapRequest;
		try {
			request = parseBootstrapRequest(frames[0]);
			this.validateRouting(request.params);
		} catch (error) {
			const failure = error instanceof BootstrapProtocolError
				? error
				: new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap claim is invalid.');
			void this.fail(requestIdFromFrame(frames[0]), failure.code, failure.message, 'invalidClaim');
			return;
		}
		void this.execute(request);
	}

	private validateRouting(claim: IBootstrapClaim): void {
		if (claim.registryEntryId !== this.options.expectedRegistryEntryId || claim.windowInstanceId !== this.options.expectedWindowInstanceId) {
			throw new BootstrapProtocolError(BootstrapErrorCode.StaleWindow, 'The Delver window registry entry is stale.');
		}
		if (claim.rootFingerprint !== this.options.expectedRootFingerprint) {
			throw new BootstrapProtocolError(BootstrapErrorCode.RootMismatch, 'The requested workspace does not match this Delver window.');
		}
	}

	private async execute(request: IBootstrapRequest): Promise<void> {
		try {
			this.state = 'authorizing';
			const authorization = await (this.options.authorize ?? denyBootstrapAuthorization)(
				this.options.peerIdentity,
				request.params,
				this.abortController.signal,
			);
			if (this.abortController.signal.aborted) {
				return;
			}
			if (authorization !== 'granted') {
				const reason = authorization === 'denied'
					? 'authorizationDenied'
					: authorization === 'expired'
						? 'authorizationExpired'
						: authorization === 'busy'
							? 'authorizationBusy'
							: 'authorizationUnavailable';
				await this.fail(request.id, BootstrapErrorCode.Denied, 'The bootstrap claim was not authorized.', reason);
				return;
			}

			this.state = 'provisioning';
			this.provision = await this.options.provisionDtp(request.params, this.abortController.signal);
			if (this.abortController.signal.aborted) {
				this.provision.dispose();
				this.provision = undefined;
				return;
			}

			this.state = 'issuing';
			const provision = this.provision;
			const lease = this.options.leases.issue(provision.endpointGeneration, () => provision.dispose());
			this.leaseId = lease.leaseId;
			provision.onDidClose(() => this.options.leases.revoke(lease.leaseId, 'endpointClosed'));
			await this.transport.write(encodeBootstrapMessage({
				id: request.id,
				result: {
					protocolVersion: BOOTSTRAP_PROTOCOL_VERSION,
					endpoint: provision.endpoint,
					leaseId: lease.leaseId,
					token: lease.token,
					expiresAt: lease.expiresAt,
				},
			}));
			this.leaseId = undefined;
			this.provision = undefined;
			this.finish('credentialIssued', true);
		} catch {
			if (!this.abortController.signal.aborted) {
				await this.fail(request.id, BootstrapErrorCode.InternalError, 'Delver could not issue a bootstrap credential.', 'internalFailure');
			}
		}
	}

	private async fail(id: number | null, code: BootstrapErrorCode, message: string, reason: BootstrapSessionCloseReason): Promise<void> {
		if (this.state === 'closed') {
			return;
		}
		try {
			await this.transport.write(encodeBootstrapMessage({ id, error: { code, message } }));
		} catch {
			// The peer disconnected; cleanup below remains authoritative.
		}
		this.finish(reason, true);
	}
}

/** Default authorization never trusts a self-asserted client identity. */
export async function denyBootstrapAuthorization(): Promise<BootstrapAuthorizationResult> {
	return 'unavailable';
}

const defaultBootstrapTimers: IBootstrapTimers = {
	setTimeout: (listener, delay) => setTimeout(listener, delay),
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

class BootstrapProtocolError extends Error {
	constructor(readonly code: BootstrapErrorCode, message: string) {
		super(message);
	}
}

function parseBootstrapRequest(body: Buffer): IBootstrapRequest {
	let value: unknown;
	try {
		value = JSON.parse(body.toString('utf8'));
	} catch {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap claim is not valid JSON.');
	}
	if (!isRecord(value) || !hasExactKeys(value, ['id', 'method', 'params']) || !Number.isSafeInteger(value.id) || (value.id as number) < 0) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap request envelope is invalid.');
	}
	if (value.method !== 'bootstrap/claim' || !isRecord(value.params)) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap method is invalid.');
	}
	const params = value.params;
	const allowedKeys = ['protocolVersion', 'registryEntryId', 'windowInstanceId', 'rootFingerprint', 'clientNonce'];
	if (params.displayName !== undefined) {
		allowedKeys.push('displayName');
	}
	if (!hasExactKeys(params, allowedKeys)) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap claim fields are invalid.');
	}
	if (params.protocolVersion !== BOOTSTRAP_PROTOCOL_VERSION) {
		throw new BootstrapProtocolError(BootstrapErrorCode.VersionMismatch, 'The bootstrap protocol version is unsupported.');
	}
	if (!isBoundedId(params.registryEntryId) || !isBoundedId(params.windowInstanceId) || typeof params.rootFingerprint !== 'string' || !ROOT_FINGERPRINT.test(params.rootFingerprint)) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap routing identity is invalid.');
	}
	if (typeof params.clientNonce !== 'string' || !CLIENT_NONCE.test(params.clientNonce)) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap client nonce is invalid.');
	}
	if (params.displayName !== undefined && (typeof params.displayName !== 'string' || params.displayName.trim().length === 0 || params.displayName.length > BOOTSTRAP_DISPLAY_NAME_MAX_LENGTH || containsUnsafeDisplayCharacters(params.displayName))) {
		throw new BootstrapProtocolError(BootstrapErrorCode.InvalidRequest, 'The bootstrap display name is invalid.');
	}
	return {
		id: value.id as number,
		method: 'bootstrap/claim',
		params: {
			protocolVersion: 1,
			registryEntryId: params.registryEntryId,
			windowInstanceId: params.windowInstanceId,
			rootFingerprint: params.rootFingerprint as string,
			clientNonce: params.clientNonce,
			...(params.displayName === undefined ? {} : { displayName: (params.displayName as string).trim() }),
		},
	};
}

/** The bound every untrusted client display label must satisfy before authorization. */
export const BOOTSTRAP_DISPLAY_NAME_MAX_LENGTH = 128;

/** Rejects control and bidi formatting characters in any untrusted display label. */
export function containsUnsafeDisplayCharacters(value: string): boolean {
	return /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function requestIdFromFrame(body: Buffer): number | null {
	try {
		const value: unknown = JSON.parse(body.toString('utf8'));
		return isRecord(value) && Number.isSafeInteger(value.id) && (value.id as number) >= 0 ? value.id as number : null;
	} catch {
		return null;
	}
}

function encodeBootstrapMessage(message: Readonly<Record<string, unknown>>): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	if (body.length > BOOTSTRAP_MAX_MESSAGE_BYTES) {
		throw new Error('The bootstrap response is too large.');
	}
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}
