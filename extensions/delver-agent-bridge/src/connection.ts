/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, timingSafeEqual } from 'crypto';
import {
	DELVER_DTP_PROTOCOL_VERSION,
	DtpErrorCode,
	DtpFrameDecoder,
	DtpProtocolError,
	encodeDtpMessage,
	IDtpRequest,
	IDtpResponse,
	isPlainObject,
	parseDtpRequest,
} from './protocol';

const MAX_CLIENT_ID_LENGTH = 128;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

export interface IDelverAgentGateway {
	capabilities(): Promise<unknown>;
	invoke(requestId: string, request: Readonly<Record<string, unknown>>): Promise<unknown>;
	cancel(requestId: string): Promise<void>;
}

export interface IDtpTokenAuthenticator {
	consume(token: string): boolean;
}

/** A byte transport supplied later by the owner-only OS endpoint. */
export interface IDtpConnectionTransport {
	onData(listener: (data: Buffer) => void): () => void;
	onClose(listener: () => void): () => void;
	write(data: Buffer): void;
	close(): void;
}

interface IInitializeParams {
	readonly protocolVersion: number;
	readonly token: string;
	readonly clientId: string;
}

/**
 * Protocol and authentication state for one DTP connection.
 *
 * This class deliberately knows nothing about named pipes, sockets, VS Code,
 * or analysis. The OS listener supplies a byte transport and the extension
 * supplies the existing two-command gateway.
 */
export class DelverDtpConnection {
	private readonly decoder = new DtpFrameDecoder();
	private readonly activeRequestIds = new Set<number>();
	private readonly activeGatewayRequestIds = new Map<number, string>();
	private readonly connectionId = randomUUID();
	private readonly removeDataListener: () => void;
	private readonly removeCloseListener: () => void;
	private initialized = false;
	private clientId: string | undefined;
	private disposed = false;

	constructor(
		private readonly transport: IDtpConnectionTransport,
		private readonly credential: string | IDtpTokenAuthenticator,
		private readonly gateway: IDelverAgentGateway,
		private readonly maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
	) {
		this.removeDataListener = transport.onData(data => this.receive(data));
		this.removeCloseListener = transport.onClose(() => this.dispose(false));
	}

	dispose(closeTransport = true): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const requestId of this.activeGatewayRequestIds.values()) {
			void this.gateway.cancel(requestId);
		}
		this.activeGatewayRequestIds.clear();
		this.activeRequestIds.clear();
		this.removeDataListener();
		this.removeCloseListener();
		if (closeTransport) {
			this.transport.close();
		}
	}

	private receive(chunk: Buffer): void {
		try {
			for (const frame of this.decoder.push(chunk)) {
				this.acceptFrame(frame);
			}
		} catch (error) {
			this.sendError(null, toProtocolError(error));
			this.dispose();
		}
	}

	private acceptFrame(frame: Buffer): void {
		let request: IDtpRequest;
		try {
			request = parseDtpRequest(frame);
		} catch (error) {
			this.sendError(null, toProtocolError(error));
			return;
		}
		if (this.activeRequestIds.has(request.id)) {
			this.sendError(request.id, new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP request id is already active.'));
			return;
		}
		const concurrencyLimit = request.method === 'agent/cancel'
			? this.maxConcurrentRequests + 1
			: this.maxConcurrentRequests;
		if (this.activeRequestIds.size >= concurrencyLimit) {
			this.sendError(request.id, new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP connection has too many active requests.'));
			return;
		}

		this.activeRequestIds.add(request.id);
		void this.handleRequest(request);
	}

	private async handleRequest(request: IDtpRequest): Promise<void> {
		try {
			const result = await this.dispatch(request);
			this.send({ id: request.id, result });
		} catch (error) {
			const protocolError = toProtocolError(error);
			this.sendError(request.id, protocolError);
			if (protocolError.code === DtpErrorCode.Unauthorized) {
				this.dispose();
			}
		} finally {
			this.activeRequestIds.delete(request.id);
		}
	}

	private async dispatch(request: IDtpRequest): Promise<unknown> {
		if (request.method === 'initialize') {
			return this.initialize(request.params);
		}
		if (!this.initialized || !this.clientId) {
			throw new DtpProtocolError(DtpErrorCode.NotInitialized, 'Authenticate this DTP connection with initialize first.');
		}

		switch (request.method) {
			case 'agent/capabilities':
				assertNoParams(request.params);
				return this.gateway.capabilities();
			case 'agent/invoke':
				return this.invoke(request);
			case 'agent/cancel':
				return this.cancel(request.params);
			default:
				throw new DtpProtocolError(DtpErrorCode.MethodNotFound, `Unknown DTP method: ${request.method}`);
		}
	}

	private initialize(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
		if (this.initialized) {
			throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'This DTP connection is already initialized.');
		}
		const validated = validateInitializeParams(params);
		if (validated.protocolVersion !== DELVER_DTP_PROTOCOL_VERSION) {
			throw new DtpProtocolError(DtpErrorCode.ProtocolVersionMismatch, `Delver DTP protocol ${DELVER_DTP_PROTOCOL_VERSION} is required.`);
		}
		if (!authenticateToken(this.credential, validated.token)) {
			throw new DtpProtocolError(DtpErrorCode.Unauthorized, 'The Delver session token is invalid.');
		}
		this.clientId = validated.clientId;
		this.initialized = true;
		return {
			protocolVersion: DELVER_DTP_PROTOCOL_VERSION,
			server: { name: 'delver-agent-bridge', version: '0.1.0' },
			methods: ['agent/capabilities', 'agent/invoke', 'agent/cancel'],
		};
	}

	private async invoke(request: IDtpRequest): Promise<unknown> {
		const gatewayRequestId = `${this.connectionId}:${request.id}`;
		this.activeGatewayRequestIds.set(request.id, gatewayRequestId);
		try {
			return await this.gateway.invoke(gatewayRequestId, {
				...request.params,
				callerId: `dtp:${this.clientId}`,
			});
		} finally {
			this.activeGatewayRequestIds.delete(request.id);
		}
	}

	private async cancel(params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, boolean>>> {
		const requestId = validateCancellationParams(params);
		const gatewayRequestId = this.activeGatewayRequestIds.get(requestId);
		if (!gatewayRequestId) {
			return { cancelled: false };
		}
		await this.gateway.cancel(gatewayRequestId);
		return { cancelled: true };
	}

	private sendError(id: number | null, error: DtpProtocolError): void {
		this.send({ id, error: { code: error.code, message: error.message } });
	}

	private send(response: IDtpResponse): void {
		if (this.disposed) {
			return;
		}
		try {
			this.transport.write(encodeDtpMessage(response));
		} catch (error) {
			if (error instanceof DtpProtocolError && error.code === DtpErrorCode.RequestTooLarge) {
				this.transport.write(encodeDtpMessage({
					id: response.id,
					error: { code: error.code, message: error.message },
				}));
			} else {
				this.dispose();
			}
		}
	}
}

function validateInitializeParams(params: Readonly<Record<string, unknown>>): IInitializeParams {
	const unknownKeys = Object.keys(params).filter(key => key !== 'protocolVersion' && key !== 'token' && key !== 'clientId');
	if (unknownKeys.length > 0 || !Number.isSafeInteger(params.protocolVersion)) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'initialize requires protocolVersion, token, and clientId only.');
	}
	if (typeof params.token !== 'string' || params.token.length === 0 || params.token.length > 256) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'initialize requires a bounded token string.');
	}
	if (typeof params.clientId !== 'string' || params.clientId.trim().length === 0 || params.clientId.length > MAX_CLIENT_ID_LENGTH) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'initialize requires a bounded clientId string.');
	}
	return {
		protocolVersion: params.protocolVersion as number,
		token: params.token,
		clientId: params.clientId.trim(),
	};
}

function assertNoParams(params: Readonly<Record<string, unknown>>): void {
	if (!isPlainObject(params) || Object.keys(params).length > 0) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'This DTP method does not accept params.');
	}
}

function validateCancellationParams(params: Readonly<Record<string, unknown>>): number {
	if (Object.keys(params).length !== 1 || !Number.isSafeInteger(params.requestId) || (params.requestId as number) < 0) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'agent/cancel requires one non-negative safe-integer requestId.');
	}
	return params.requestId as number;
}

function tokensEqual(expected: string, actual: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const actualBytes = Buffer.from(actual, 'utf8');
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function authenticateToken(credential: string | IDtpTokenAuthenticator, actual: string): boolean {
	return typeof credential === 'string' ? tokensEqual(credential, actual) : credential.consume(actual);
}

function toProtocolError(error: unknown): DtpProtocolError {
	return error instanceof DtpProtocolError
		? error
		: new DtpProtocolError(DtpErrorCode.InternalError, 'Delver could not complete the DTP request.');
}
