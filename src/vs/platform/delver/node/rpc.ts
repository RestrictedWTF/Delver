/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { connect } from 'net';
import { Readable, Writable } from 'stream';
import { IErrorData, IRequest, IResponse, IRpcError } from '../common/protocol.generated.js';

/**
 * Translates a Delver endpoint string into a path `net.connect` understands.
 */
function socketPathFor(endpoint: string): string {
	if (endpoint.startsWith('pipe://') || endpoint.startsWith('npipe://')) {
		const name = endpoint.slice(endpoint.indexOf('//') + 2);
		return name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`;
	}
	if (endpoint.startsWith('unix://')) {
		return endpoint.slice('unix://'.length);
	}
	return endpoint;
}

export interface IRpcMessage {
	readonly json: IResponse;
	readonly frames?: ReadonlyArray<{ frameId: number; data: Buffer }>;
}

export interface IRpcTransport {
	readonly reader: Readable;
	readonly writer: Writable;
}

/** Error returned by a Delver RPC peer. */
export class DelverRpcError extends Error {
	readonly code: number;
	readonly data: IErrorData | undefined;

	constructor(error: IRpcError) {
		super(error.data?.detail ? `${error.message}: ${error.data.detail}` : error.message);
		this.name = 'DelverRpcError';
		this.code = error.code;
		this.data = error.data;
	}
}

/**
 * Buffered reader over the transport.
 *
 * **Single-reader only.** `resolveNext` holds one waiter, so a second concurrent
 * read would overwrite the first and leave it parked forever. `DelverRpcClient`
 * guarantees this by serializing calls; anything reading the transport directly
 * has to preserve it.
 */
class StreamReader {
	private buffer = Buffer.alloc(0);
	private resolveNext?: () => void;
	private ended = false;
	private error?: Error;

	constructor(stream: Readable) {
		stream.on('data', chunk => {
			this.buffer = Buffer.concat([this.buffer, chunk as Buffer]);
			this.notify();
		});
		stream.on('end', () => {
			this.ended = true;
			this.notify();
		});
		stream.on('error', err => {
			this.error = err;
			this.notify();
		});
	}

	private notify() {
		if (this.resolveNext) {
			const resolve = this.resolveNext;
			this.resolveNext = undefined;
			resolve();
		}
	}

	async readUntil(separator: Buffer): Promise<Buffer> {
		while (true) {
			const idx = this.buffer.indexOf(separator);
			if (idx !== -1) {
				const result = this.buffer.subarray(0, idx);
				this.buffer = this.buffer.subarray(idx + separator.length);
				return result;
			}
			if (this.error) {
				throw this.error;
			}
			if (this.ended) {
				throw new Error('Unexpected end of stream while reading header');
			}
			await new Promise<void>(resolve => this.resolveNext = resolve);
		}
	}

	/**
	 * Fails this reader permanently, waking whatever read is parked on it.
	 *
	 * Used when framing breaks: the reader no longer knows where the next message
	 * begins, so continuing to hand out bytes is worse than stopping.
	 */
	fail(error: Error): void {
		this.error ??= error;
		this.notify();
	}

	async readBytes(length: number): Promise<Buffer> {
		while (this.buffer.length < length) {
			if (this.error) {
				throw this.error;
			}
			if (this.ended) {
				throw new Error('Unexpected end of stream while reading body');
			}
			await new Promise<void>(resolve => this.resolveNext = resolve);
		}
		const result = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return result;
	}
}

/**
 * Low-level Delver RPC client that speaks the LSP-style framing protocol.
 */
export class DelverRpcClient {
	private readonly transport: IRpcTransport;
	private readonly reader: StreamReader;
	private readonly writer: Writable;
	private nextId = 1;

	/**
	 * Set once the framing is known to be broken.
	 *
	 * A desync is not recoverable on an ordered stream: the reader has lost the
	 * message boundary, so every later call would answer with somebody else's
	 * bytes. Recording it here turns the whole connection into a reported
	 * failure, which the caller can reconnect from, instead of a silent wrong
	 * answer it cannot detect.
	 */
	private broken: Error | undefined;

	/**
	 * Tail of the in-flight call chain.
	 *
	 * The transport is a single ordered stream and a response's binary frames
	 * follow it immediately (ADR 0001), so replies can only be read in the order
	 * the requests went out. Two overlapping `call()`s would therefore each read
	 * whichever reply arrived first — the caller of request 3 consuming the
	 * response to request 2. Serializing here is what makes the client safe for
	 * concurrent callers, which is the normal case as soon as more than one view
	 * is asking for data.
	 */
	private tail: Promise<unknown> = Promise.resolve();

	constructor(transport: IRpcTransport) {
		this.transport = transport;
		this.reader = new StreamReader(transport.reader);
		this.writer = transport.writer;
	}

	/**
	 * Connects to a listening Delver server over a local endpoint.
	 *
	 * Accepts the same endpoint strings the Rust side emits: `pipe://<name>` on
	 * Windows and `unix://<path>` elsewhere. A socket is duplex, so it serves as
	 * both halves of the transport.
	 */
	static connect(endpoint: string): Promise<DelverRpcClient> {
		const target = socketPathFor(endpoint);

		return new Promise<DelverRpcClient>((resolve, reject) => {
			const socket = connect(target);
			const onError = (err: Error) => {
				socket.off('connect', onConnect);
				reject(new Error(`Failed to connect to ${endpoint}: ${err.message}`));
			};
			const onConnect = () => {
				socket.off('error', onError);
				resolve(new DelverRpcClient({ reader: socket, writer: socket }));
			};
			socket.once('error', onError);
			socket.once('connect', onConnect);
		});
	}

	/**
	 * Sends a request and returns the response. Binary frames referenced by the
	 * response are consumed and returned alongside the JSON.
	 */
	call(method: string, params: unknown, expectedFrames = 0): Promise<IRpcMessage> {
		if (this.broken) {
			return Promise.reject(this.broken);
		}
		const result = this.tail.then(() => this.sendAndReceive(method, params, expectedFrames));

		// The chain must survive a failed call. Without swallowing the rejection
		// here, one error would reject every request queued behind it — and would
		// also surface as an unhandled rejection when a caller already handled it.
		this.tail = result.then(() => undefined, () => undefined);

		return result;
	}

	private async sendAndReceive(method: string, params: unknown, expectedFrames: number): Promise<IRpcMessage> {
		if (this.broken) {
			throw this.broken;
		}
		const id = this.nextId++;
		const request: IRequest = { id, method, params };
		await this.writeJson(request);

		const json = await this.readJson();
		if (json.id !== id) {
			// Now that calls are serialized this means the stream itself is out of
			// step — an unsolicited message, or a server that answered out of
			// order. Either way the connection can no longer be trusted.
			throw this.breakConnection(`RPC id mismatch: expected ${id}, got ${json.id}`);
		}
		if (json.error) {
			throw new DelverRpcError(json.error);
		}

		const frames: { frameId: number; data: Buffer }[] = [];
		for (let i = 0; i < expectedFrames; i++) {
			frames.push(await this.readFrame());
		}

		return { json, frames };
	}

	/**
	 * Reads the next JSON message from the transport.
	 */
	async readJson(): Promise<IResponse> {
		const header = await this.readHeader();
		const contentLength = this.headerCount(header, 'Content-Length');
		const body = await this.reader.readBytes(contentLength);
		return JSON.parse(body.toString('utf-8')) as IResponse;
	}

	/**
	 * Reads the next binary frame from the transport.
	 */
	async readFrame(): Promise<{ frameId: number; data: Buffer }> {
		const header = await this.readHeader();
		// A missing `Delver-Frame` means the peer sent a JSON message where the
		// frame that answers this request was supposed to be (ADR 0001: the frame
		// immediately follows its message). Reading it as a frame anyway is the
		// desync itself, so it fails the connection here.
		const frameId = this.headerCount(header, 'Delver-Frame');
		const contentLength = this.headerCount(header, 'Content-Length');
		const data = await this.reader.readBytes(contentLength);
		return { frameId, data };
	}

	private async readHeader(): Promise<Map<string, string>> {
		const raw = await this.reader.readUntil(Buffer.from('\r\n\r\n'));
		const text = raw.toString('utf-8');
		const map = new Map<string, string>();
		for (const line of text.split('\r\n')) {
			if (!line) {
				continue;
			}
			const colon = line.indexOf(':');
			if (colon === -1) {
				throw this.breakConnection(`Malformed header line: ${line}`);
			}
			map.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		}
		return map;
	}

	/**
	 * Reads a header field that ADR 0001 defines as a plain decimal count.
	 *
	 * `Number(undefined)` is `NaN`, and a `NaN` length reads zero bytes: the
	 * message body is then still in the buffer and every later read is one
	 * message behind, with nothing anywhere saying so.
	 */
	private headerCount(header: Map<string, string>, name: string): number {
		const raw = header.get(name);
		if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
			throw this.breakConnection(`Malformed ${name} header: ${raw ?? 'absent'}`);
		}
		return Number(raw);
	}

	/**
	 * Records a framing failure, tears the transport down, and returns the error
	 * to throw. The first failure is the one every later caller is told about.
	 */
	private breakConnection(reason: string): Error {
		if (!this.broken) {
			this.broken = new Error(`Delver RPC connection desynchronized: ${reason}`);
			this.reader.fail(this.broken);
			this.transport.reader.destroy();
			this.transport.writer.destroy();
		}
		return this.broken;
	}

	private writeJson(message: IRequest): Promise<void> {
		const payload = Buffer.from(JSON.stringify(message), 'utf-8');
		const header = `Content-Length: ${payload.length}\r\n\r\n`;
		return this.write(Buffer.concat([Buffer.from(header, 'utf-8'), payload]));
	}

	private write(data: Buffer): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.writer.write(data)) {
				this.writer.once('drain', resolve);
				this.writer.once('error', reject);
			} else {
				resolve();
			}
		});
	}
}
