/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
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
import { addressSpaceFromWire, capabilitiesFromWire, descriptorFromWire } from '../common/wire.js';
import { resolveBinary } from './delverBinaries.js';

/**
 * Manages a Delver provider child process and exposes the attached target.
 */
export class DelverProviderProcess implements IDelverTarget {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly rpc: DelverRpcClient;
	private disposed = false;

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
	static async attach(config: TargetConfig): Promise<DelverProviderProcess> {
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
			return new DelverProviderProcess(child, rpc, json.result as IInitializeResult);
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
	 */
	async readMemory(params: { space: string; address: string; len: number }) {
		const { json, frames } = await this.rpc.call('readMemory', params, 1);
		return { response: json.result, frame: frames?.[0] };
	}

	/**
	 * Sends `shutdown` and waits for the provider to exit.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.rpc.call('shutdown', null).catch(() => {
			// ignore
		}).finally(() => {
			this.child.kill();
		});
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

