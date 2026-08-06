/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'stream';
import { IRequest, IResponse } from './protocol.generated.js';

export interface IRpcMessage {
	readonly json: IResponse;
	readonly frames?: ReadonlyArray<{ frameId: number; data: Buffer }>;
}

export interface IRpcTransport {
	readonly reader: Readable;
	readonly writer: Writable;
}

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
	private readonly reader: StreamReader;
	private readonly writer: Writable;
	private nextId = 1;

	constructor(transport: IRpcTransport) {
		this.reader = new StreamReader(transport.reader);
		this.writer = transport.writer;
	}

	/**
	 * Sends a request and returns the response. Binary frames referenced by the
	 * response are consumed and returned alongside the JSON.
	 */
	async call(method: string, params: unknown, expectedFrames = 0): Promise<IRpcMessage> {
		const id = this.nextId++;
		const request: IRequest = { id, method, params };
		await this.writeJson(request);

		const json = await this.readJson();
		if (json.id !== id) {
			throw new Error(`RPC id mismatch: expected ${id}, got ${json.id}`);
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
		const contentLength = Number(header.get('Content-Length'));
		const body = await this.reader.readBytes(contentLength);
		return JSON.parse(body.toString('utf-8')) as IResponse;
	}

	/**
	 * Reads the next binary frame from the transport.
	 */
	async readFrame(): Promise<{ frameId: number; data: Buffer }> {
		const header = await this.readHeader();
		const frameId = Number(header.get('Delver-Frame'));
		const contentLength = Number(header.get('Content-Length'));
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
				throw new Error(`Malformed header line: ${line}`);
			}
			map.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		}
		return map;
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
