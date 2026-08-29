/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRelayProcess } from '../relayProcess';
import { IRelayTimers } from '../relaySupervisor';

export class TestRelayProcess implements IRelayProcess {
	private readonly stdoutListeners = new Set<(data: Buffer) => void>();
	private readonly stderrListeners = new Set<(data: Buffer) => void>();
	private readonly exitListeners = new Set<(code: number | null) => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly drainListeners = new Set<() => void>();
	readonly writes: { readonly data: Buffer; readonly callback: (error?: Error | null) => void }[] = [];
	readonly writeResults: boolean[] = [];
	endCount = 0;
	terminateCount = 0;
	forcedTerminateCount = 0;

	write(data: Buffer, callback: (error?: Error | null) => void): boolean {
		this.writes.push({ data: Buffer.from(data), callback });
		return this.writeResults.shift() ?? true;
	}

	onDrain(listener: () => void): () => void {
		const once = () => {
			this.drainListeners.delete(once);
			listener();
		};
		this.drainListeners.add(once);
		return () => this.drainListeners.delete(once);
	}

	endInput(): void {
		this.endCount++;
	}

	onStdout(listener: (data: Buffer) => void): () => void {
		this.stdoutListeners.add(listener);
		return () => this.stdoutListeners.delete(listener);
	}

	onStderr(listener: (data: Buffer) => void): () => void {
		this.stderrListeners.add(listener);
		return () => this.stderrListeners.delete(listener);
	}

	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	terminate(force = false): void {
		this.terminateCount++;
		if (force) {
			this.forcedTerminateCount++;
		}
	}

	emitStdout(data: string | Buffer): void {
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		for (const listener of [...this.stdoutListeners]) {
			listener(buffer);
		}
	}

	emitStderr(data: string | Buffer): void {
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		for (const listener of [...this.stderrListeners]) {
			listener(buffer);
		}
	}

	emitExit(code: number | null): void {
		for (const listener of [...this.exitListeners]) {
			listener(code);
		}
	}

	emitError(error = new Error('relay failed')): void {
		for (const listener of [...this.errorListeners]) {
			listener(error);
		}
	}

	emitDrain(): void {
		for (const listener of [...this.drainListeners]) {
			listener();
		}
	}

	listenerCounts(): { readonly stdout: number; readonly stderr: number; readonly exit: number; readonly error: number } {
		return {
			stdout: this.stdoutListeners.size,
			stderr: this.stderrListeners.size,
			exit: this.exitListeners.size,
			error: this.errorListeners.size,
		};
	}
}

interface ITestTimer {
	readonly listener: () => void;
	readonly delay: number;
}

export class TestRelayTimers implements IRelayTimers {
	private readonly pending = new Map<object, ITestTimer>();

	setTimeout(listener: () => void, delay: number): object {
		const handle = {};
		this.pending.set(handle, { listener, delay });
		return handle;
	}

	clearTimeout(timer: object): void {
		this.pending.delete(timer);
	}

	pendingDelays(): readonly number[] {
		return [...this.pending.values()].map(timer => timer.delay).sort((left, right) => left - right);
	}

	runDelay(delay: number): void {
		const entry = [...this.pending.entries()].find(([, timer]) => timer.delay === delay);
		if (!entry) {
			throw new Error(`No timer is pending for ${delay}ms.`);
		}
		this.pending.delete(entry[0]);
		entry[1].listener();
	}
}
