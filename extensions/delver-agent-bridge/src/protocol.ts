/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const DELVER_DTP_PROTOCOL_VERSION = 1;
export const DELVER_DTP_MAX_HEADER_BYTES = 8 * 1024;
export const DELVER_DTP_MAX_MESSAGE_BYTES = 512 * 1024;

export const enum DtpErrorCode {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
	Unauthorized = -32001,
	NotInitialized = -32002,
	ProtocolVersionMismatch = -32003,
	RequestTooLarge = -32004,
}

export interface IDtpRequest {
	readonly id: number;
	readonly method: string;
	readonly params: Readonly<Record<string, unknown>>;
}

export interface IDtpError {
	readonly code: DtpErrorCode;
	readonly message: string;
	readonly data?: Readonly<Record<string, unknown>>;
}

export type IDtpResponse = {
	readonly id: number | null;
	readonly result: unknown;
} | {
	readonly id: number | null;
	readonly error: IDtpError;
};

export class DtpProtocolError extends Error {
	constructor(
		readonly code: DtpErrorCode,
		message: string,
	) {
		super(message);
	}
}

/** Incrementally decodes bounded `Content-Length` JSON frames. */
export class DtpFrameDecoder {
	private buffer = Buffer.alloc(0);

	constructor(
		private readonly maxHeaderBytes = DELVER_DTP_MAX_HEADER_BYTES,
		private readonly maxMessageBytes = DELVER_DTP_MAX_MESSAGE_BYTES,
	) { }

	push(chunk: Buffer): readonly Buffer[] {
		if (chunk.length === 0) {
			return [];
		}
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const frames: Buffer[] = [];

		while (this.buffer.length > 0) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				if (this.buffer.length > this.maxHeaderBytes) {
					throw new DtpProtocolError(DtpErrorCode.RequestTooLarge, 'The DTP frame header exceeds the configured limit.');
				}
				break;
			}
			if (headerEnd > this.maxHeaderBytes) {
				throw new DtpProtocolError(DtpErrorCode.RequestTooLarge, 'The DTP frame header exceeds the configured limit.');
			}

			const contentLength = parseContentLength(this.buffer.subarray(0, headerEnd).toString('utf8'));
			if (contentLength > this.maxMessageBytes) {
				throw new DtpProtocolError(DtpErrorCode.RequestTooLarge, 'The DTP message exceeds the configured limit.');
			}
			const frameEnd = headerEnd + 4 + contentLength;
			if (this.buffer.length < frameEnd) {
				break;
			}

			frames.push(this.buffer.subarray(headerEnd + 4, frameEnd));
			this.buffer = this.buffer.subarray(frameEnd);
		}

		return frames;
	}
}

export function encodeDtpMessage(message: IDtpResponse | Readonly<Record<string, unknown>>): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	if (body.length > DELVER_DTP_MAX_MESSAGE_BYTES) {
		throw new DtpProtocolError(DtpErrorCode.RequestTooLarge, 'The DTP message exceeds the configured limit.');
	}
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export function parseDtpRequest(body: Buffer): IDtpRequest {
	let value: unknown;
	try {
		value = JSON.parse(body.toString('utf8'));
	} catch {
		throw new DtpProtocolError(DtpErrorCode.ParseError, 'The DTP message is not valid JSON.');
	}
	if (!isPlainObject(value)) {
		throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP request must be a JSON object.');
	}
	const unknownKeys = Object.keys(value).filter(key => key !== 'id' && key !== 'method' && key !== 'params');
	if (unknownKeys.length > 0) {
		throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP request contains unsupported fields.');
	}
	if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) {
		throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP request id must be a non-negative safe integer.');
	}
	if (typeof value.method !== 'string' || value.method.length === 0 || value.method.length > 128) {
		throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP request method must be a non-empty bounded string.');
	}
	if (value.params !== undefined && !isPlainObject(value.params)) {
		throw new DtpProtocolError(DtpErrorCode.InvalidParams, 'DTP request params must be a JSON object when supplied.');
	}
	return {
		id: value.id as number,
		method: value.method,
		params: value.params ?? {},
	};
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseContentLength(header: string): number {
	let contentLength: number | undefined;
	for (const line of header.split('\r\n')) {
		const separator = line.indexOf(':');
		if (separator < 0) {
			throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'A DTP frame header line is malformed.');
		}
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === 'delver-frame') {
			throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'Binary DTP frames are not accepted by the agent endpoint.');
		}
		if (key === 'content-length') {
			if (contentLength !== undefined || !/^\d+$/.test(value)) {
				throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP Content-Length header is invalid.');
			}
			contentLength = Number(value);
		}
	}
	if (contentLength === undefined || !Number.isSafeInteger(contentLength)) {
		throw new DtpProtocolError(DtpErrorCode.InvalidRequest, 'The DTP frame requires a valid Content-Length header.');
	}
	return contentLength;
}
