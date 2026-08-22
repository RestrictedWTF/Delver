/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BOOTSTRAP_MAX_HEADER_BYTES, BOOTSTRAP_MAX_MESSAGE_BYTES, IBootstrapTransport } from './bootstrap';
import { IRelayProcess } from './relayProcess';
import { RelayProcessTransport } from './relayTransport';

const FRAME_DELIMITER_BYTES = 4;
export const BOOTSTRAP_MAX_BUFFERED_INPUT_BYTES = BOOTSTRAP_MAX_HEADER_BYTES + FRAME_DELIMITER_BYTES + BOOTSTRAP_MAX_MESSAGE_BYTES;

type InputState = 'buffering' | 'flushing' | 'live' | 'closed';

/** Buffers one bounded bootstrap claim until OS peer attestation has completed. */
export class GatedBootstrapRelayTransport implements IBootstrapTransport {
	private readonly transport: RelayProcessTransport;
	private readonly dataListeners = new Set<(data: Buffer) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly bufferedData: Buffer[] = [];
	private readonly removeDataListener: () => void;
	private readonly removeCloseListener: () => void;
	private bufferedBytes = 0;
	private state: InputState = 'buffering';

	constructor(process: IRelayProcess, private readonly maxBufferedBytes = BOOTSTRAP_MAX_BUFFERED_INPUT_BYTES) {
		if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1 || maxBufferedBytes > BOOTSTRAP_MAX_BUFFERED_INPUT_BYTES) {
			throw new Error('The bootstrap input buffer limit is invalid.');
		}
		this.transport = new RelayProcessTransport(process);
		this.removeDataListener = this.transport.onData(data => this.receive(data));
		this.removeCloseListener = this.transport.onClose(() => this.finishClose());
	}

	onData(listener: (data: Buffer) => void): () => void {
		if (this.state === 'closed') {
			return () => { };
		}
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		if (this.state === 'closed') {
			listener();
			return () => { };
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	write(data: Buffer): Promise<void> {
		return this.transport.writeAsync(data);
	}

	close(): void {
		this.transport.close();
	}

	/** Releases buffered claim fragments after the bootstrap session listener is installed. */
	release(): void {
		if (this.state !== 'buffering' || this.dataListeners.size === 0) {
			throw new Error('The bootstrap input gate cannot be released safely.');
		}
		this.state = 'flushing';
		while (this.bufferedData.length > 0 && this.state === 'flushing') {
			const data = this.bufferedData.shift()!;
			this.bufferedBytes -= data.length;
			this.emitData(data);
		}
		if (this.state === 'flushing') {
			this.state = 'live';
		}
	}

	/** Immediately terminates the unpublished or failed bootstrap relay. */
	terminate(): void {
		this.transport.terminate();
	}

	private receive(data: Buffer): void {
		if (this.state === 'closed') {
			return;
		}
		if (this.state === 'live') {
			this.emitData(data);
			return;
		}
		if (data.length > this.maxBufferedBytes - this.bufferedBytes) {
			this.transport.terminate();
			return;
		}
		const copy = Buffer.from(data);
		this.bufferedData.push(copy);
		this.bufferedBytes += copy.length;
	}

	private emitData(data: Buffer): void {
		for (const listener of [...this.dataListeners]) {
			listener(data);
		}
	}

	private finishClose(): void {
		if (this.state === 'closed') {
			return;
		}
		this.state = 'closed';
		this.bufferedData.length = 0;
		this.bufferedBytes = 0;
		this.removeDataListener();
		this.removeCloseListener();
		for (const listener of [...this.closeListeners]) {
			listener();
		}
		this.dataListeners.clear();
		this.closeListeners.clear();
	}
}
