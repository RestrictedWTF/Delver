/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDtpConnectionTransport } from './connection';
import { IRelayProcess } from './relayProcess';

const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

interface IPendingWrite {
	readonly data: Buffer;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

/** Adapts relay stdio to DTP with bounded, serialized, backpressure-aware writes. */
export class RelayProcessTransport implements IDtpConnectionTransport {
	private readonly dataListeners = new Set<(data: Buffer) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly pendingWrites: IPendingWrite[] = [];
	private readonly removeStdoutListener: () => void;
	private readonly removeExitListener: () => void;
	private readonly removeErrorListener: () => void;
	private removeDrainListener: (() => void) | undefined;
	private queuedBytes = 0;
	private activeWrite: IPendingWrite | undefined;
	private writing = false;
	private closing = false;
	private closed = false;

	constructor(
		private readonly process: IRelayProcess,
		private readonly maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
	) {
		this.removeStdoutListener = process.onStdout(data => {
			for (const listener of this.dataListeners) {
				listener(data);
			}
		});
		this.removeExitListener = process.onExit(() => this.finishClose(false, false));
		this.removeErrorListener = process.onError(() => this.finishClose(true, true));
	}

	onData(listener: (data: Buffer) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** Fire-and-forget write; a queue or transport failure closes the relay, never the caller. */
	write(data: Buffer): void {
		void this.writeAsync(data).catch(() => undefined);
	}

	/** Resolves only after the child write callback and any backpressure drain complete. */
	writeAsync(data: Buffer): Promise<void> {
		try {
			return this.enqueue(data);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private enqueue(data: Buffer): Promise<void> {
		if (this.closed || this.closing) {
			throw new Error('The Delver relay transport is closed.');
		}
		if (data.length > this.maxQueuedBytes - this.queuedBytes) {
			const error = new Error('The Delver relay transport write queue is full.');
			this.finishClose(true, true, error);
			throw error;
		}
		const copy = Buffer.from(data);
		return new Promise<void>((resolve, reject) => {
			this.pendingWrites.push({ data: copy, resolve, reject });
			this.queuedBytes += copy.length;
			this.pump();
		});
	}

	close(): void {
		if (this.closed || this.closing) {
			return;
		}
		this.closing = true;
		this.pump();
	}

	/** Immediately tears down a relay attempt without waiting for queued writes. */
	terminate(): void {
		this.finishClose(true, true);
	}

	private pump(): void {
		if (this.closed || this.writing) {
			return;
		}
		const next = this.pendingWrites.shift();
		if (!next) {
			if (this.closing) {
				this.finishClose(true, false);
			}
			return;
		}

		this.writing = true;
		this.activeWrite = next;
		let callbackComplete = false;
		let drainComplete = false;
		let writeReturned = false;
		const finish = () => {
			if (!writeReturned || !callbackComplete || !drainComplete || this.closed) {
				return;
			}
			this.removeDrainListener?.();
			this.removeDrainListener = undefined;
			this.queuedBytes -= next.data.length;
			this.writing = false;
			this.activeWrite = undefined;
			next.resolve();
			this.pump();
		};

		let accepted: boolean;
		try {
			accepted = this.process.write(next.data, error => {
				if (error) {
					this.finishClose(true, true, error);
					return;
				}
				callbackComplete = true;
				finish();
			});
		} catch (error) {
			this.finishClose(true, true, error instanceof Error ? error : new Error('The Delver relay write failed.'));
			return;
		}
		writeReturned = true;
		if (this.closed) {
			return;
		}
		if (accepted) {
			drainComplete = true;
		} else {
			this.removeDrainListener = this.process.onDrain(() => {
				drainComplete = true;
				finish();
			});
		}
		finish();
	}

	private finishClose(endInput: boolean, terminate: boolean, error = new Error('The Delver relay transport closed before the write completed.')): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.closing = true;
		const pendingWrites = this.pendingWrites.splice(0);
		const activeWrite = this.activeWrite;
		this.activeWrite = undefined;
		this.queuedBytes = 0;
		this.writing = false;
		this.removeDrainListener?.();
		this.removeDrainListener = undefined;
		this.removeStdoutListener();
		this.removeExitListener();
		this.removeErrorListener();
		if (endInput) {
			this.process.endInput();
		}
		if (terminate) {
			this.process.terminate();
		}
		activeWrite?.reject(error);
		for (const pendingWrite of pendingWrites) {
			pendingWrite.reject(error);
		}
		for (const listener of this.closeListeners) {
			listener();
		}
		this.dataListeners.clear();
		this.closeListeners.clear();
	}
}
