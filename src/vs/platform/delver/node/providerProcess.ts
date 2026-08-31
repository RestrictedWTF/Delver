/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { raceTimeout } from '../../../base/common/async.js';
import { DelverRpcClient } from './rpc.js';
import { IAddressSpace } from '../common/address.js';
import { TargetCapability } from '../common/capabilities.js';
import { IDelverTargetSnapshot } from '../common/delverProcessService.js';
import { IDelverTarget, ITargetDescriptor, TargetConfig } from '../common/target.js';
import {
	IGetImageInfoResult,
	IInitializeResult,
	IListSpacesResult,
} from '../common/protocol.generated.js';
import { IMoment, STATIC_MOMENT } from '../common/moment.js';
import { readInitializeResult } from '../common/protocolVersion.js';
import { addressSpaceFromWire, capabilitiesFromWire, descriptorFromWire, momentToWire } from '../common/wire.js';
import { resolveBinary } from './delverBinaries.js';

/** How long a provider gets to honour `shutdown` before it is signalled. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

/** How long the signalled provider gets before the signal is escalated. */
const DEFAULT_FORCED_EXIT_TIMEOUT_MS = 1_000;

/**
 * The steps a provider exit escalates through, as plain operations.
 *
 * Kept separate from the child process so the escalation can be driven without
 * faking a `ChildProcess`: what has to be right is the order of the steps and
 * the fact that every one of them is bounded, not the transport underneath.
 */
export interface IProviderExitSteps {
	/** Asks the provider to leave. A rejection is a wedged provider, not a bug. */
	requestShutdown(): Promise<void>;

	/** Resolves `true` if the child was gone within `timeoutMs`. */
	exitedWithin(timeoutMs: number): Promise<boolean>;

	/** Signals the child. `SIGKILL` is the unignorable last resort. */
	kill(signal?: 'SIGKILL'): void;
}

/**
 * Bounds the wait for a provider to exit, and always settles.
 *
 * A provider that is alive but wedged never answers `shutdown`. Hanging the
 * kill off that answer meant the child was never killed at all, and a live
 * provider keeps the sample mmapped — which on Windows locks the very file the
 * analyst is working on. So each step gets a budget, and the next one runs once
 * that budget is spent, whether or not the previous step ever replied.
 */
export async function escalateProviderExit(
	steps: IProviderExitSteps,
	shutdownTimeoutMs: number,
	forcedExitTimeoutMs: number,
): Promise<void> {
	// Deliberately not awaited: a wedged provider never answers, and waiting on
	// the answer is the bug. The reply matters only as a reason the child exits.
	steps.requestShutdown().catch(() => undefined);
	if (await steps.exitedWithin(shutdownTimeoutMs)) {
		return;
	}
	steps.kill();
	if (await steps.exitedWithin(forcedExitTimeoutMs)) {
		return;
	}
	// Last resort. A provider that ignored both the request and the terminate
	// signal will not release the mapping on its own, and the host cannot stay
	// attached to it forever.
	steps.kill('SIGKILL');
}

/** Tuning for {@link DelverProviderProcess.attach}. */
export interface IDelverProviderProcessOptions {
	/** How long a provider gets to honour `shutdown` before it is signalled. */
	readonly shutdownTimeoutMs?: number;

	/** How long the signalled provider gets before the signal is escalated. */
	readonly forcedExitTimeoutMs?: number;
}

/**
 * Manages a Delver provider child process and exposes the attached target.
 */
export class DelverProviderProcess implements IDelverTarget {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly rpc: DelverRpcClient;
	private disposed = false;

	/** Resolves once the child is actually gone, however it went. */
	private readonly childExited: Promise<void>;

	/** The in-flight escalation, so a second waiter joins the first. */
	private exiting: Promise<void> | undefined;

	readonly descriptor: ITargetDescriptor;
	readonly capabilities: readonly TargetCapability[];
	readonly spaces: readonly IAddressSpace[];

	/**
	 * The same state in the form that crosses the process boundary. Kept as it
	 * arrived rather than converted back from the domain values, so nothing has
	 * to round-trip a `bigint` through a string.
	 */
	readonly snapshot: IDelverTargetSnapshot;

	private constructor(
		child: ChildProcessWithoutNullStreams,
		rpc: DelverRpcClient,
		init: IInitializeResult,
		private readonly shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
		private readonly forcedExitTimeoutMs = DEFAULT_FORCED_EXIT_TIMEOUT_MS,
	) {
		this.child = child;
		this.rpc = rpc;
		this.descriptor = descriptorFromWire(init.target);
		this.capabilities = Object.freeze(capabilitiesFromWire(init.capabilities));
		this.spaces = Object.freeze(init.spaces.map(addressSpaceFromWire));
		this.snapshot = Object.freeze({
			descriptor: init.target,
			capabilities: Object.freeze([...init.capabilities]),
			spaces: Object.freeze([...init.spaces]),
		});

		// 'error' counts as gone: a child whose handle broke will never emit
		// 'exit' either, and a waiter must not hang on the event that is missing.
		this.childExited = new Promise<void>(resolve => {
			child.once('exit', () => resolve());
			child.once('error', () => resolve());
		});

		child.on('exit', (code, signal) => {
			this.disposed = true;
			if (code !== 0 && code !== null) {
				console.error(`provider-file exited with code ${code}, signal ${signal}`);
			}
		});
	}

	/**
	 * Spawns a provider for the given target configuration and returns the
	 * attached target once `initialize` succeeds.
	 */
	static async attach(config: TargetConfig, options: IDelverProviderProcessOptions = {}): Promise<DelverProviderProcess> {
		const { args, binaryName } = commandLineFor(config);
		const child = spawn(resolveBinary(binaryName), args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// The provider's stderr is the only place a spawn or parse failure is
		// explained, and nothing else is reading it.
		child.stderr.on('data', data => {
			console.error(`[${binaryName}] ${data.toString().trimEnd()}`);
		});

		// A spawn failure — missing binary, no execute permission — arrives as an
		// 'error' event rather than a non-zero exit. Unhandled it takes down the
		// host process, and the handshake below would never settle either way,
		// so it has to race the handshake instead of being left to chance.
		const spawnFailed = new Promise<never>((_, reject) => {
			child.once('error', err => reject(new Error(`Could not start ${binaryName}: ${err.message}`)));
		});
		spawnFailed.catch(() => undefined); // Observed only if it wins the race.

		const rpc = new DelverRpcClient({ reader: child.stdout, writer: child.stdin });

		try {
			const { json } = await Promise.race([rpc.call('initialize', null), spawnFailed]);
			return new DelverProviderProcess(
				child,
				rpc,
				readInitializeResult(json.result, binaryName),
				options.shutdownTimeoutMs,
				options.forcedExitTimeoutMs,
			);
		} catch (e) {
			child.kill();
			throw e;
		}
	}

	/**
	 * Calls `listSpaces` on the provider.
	 */
	async listSpaces(): Promise<IAddressSpace[]> {
		const { json } = await this.rpc.call('listSpaces', null);
		const result = json.result as IListSpacesResult;
		return result.spaces.map(addressSpaceFromWire);
	}

	/**
	 * Calls `getImageInfo` on the provider.
	 */
	async getImageInfo(): Promise<IGetImageInfoResult> {
		const { json } = await this.rpc.call('getImageInfo', null);
		return json.result as IGetImageInfoResult;
	}

	/**
	 * Calls `readMemory` on the provider and returns the response plus the
	 * binary frame.
	 *
	 * A read carries a Moment as well as a location (CLAUDE.md invariant 1).
	 * The caller may name one; omitting it means the static moment, which is
	 * the only one a file target has.
	 */
	async readMemory(params: { space: string; address: string; len: number; moment?: IMoment }) {
		const { space, address, len, moment = STATIC_MOMENT } = params;
		const { json, frames } = await this.rpc.call('readMemory', { space, address, len, moment: momentToWire(moment) }, 1);
		return { response: json.result, frame: frames?.[0] };
	}

	/**
	 * Asks the provider to leave, and makes sure it goes.
	 *
	 * Returns synchronously because {@link IDelverTarget} disposal does; see
	 * {@link whenExited} for joining the escalation this starts.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.exiting = escalateProviderExit(
			{
				requestShutdown: async () => {
					await this.rpc.call('shutdown', null);
				},
				exitedWithin: async timeoutMs =>
					await raceTimeout(this.childExited.then(() => true), timeoutMs) === true,
				kill: signal => this.child.kill(signal),
			},
			this.shutdownTimeoutMs,
			this.forcedExitTimeoutMs,
		).catch(() => undefined); // Best-effort by design; `whenExited` must settle.
	}

	/**
	 * Settles when the child is really gone, or when the escalation has run out
	 * of ways to make it go.
	 *
	 * `dispose()` can only promise that the release was *asked for*. A caller
	 * that must know the sample is unmapped before it touches the file again —
	 * re-attaching to it, or closing the window — needs this instead.
	 */
	async whenExited(): Promise<void> {
		await (this.exiting ?? this.childExited);
	}
}

function commandLineFor(config: TargetConfig): { binaryName: string; args: string[] } {
	switch (config.kind) {
		case 'file':
			return { binaryName: 'provider-file', args: [config.path] };
		default:
			throw new Error(`Unsupported target kind: ${(config as TargetConfig).kind}`);
	}
}

