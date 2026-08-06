/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { DelverRpcClient } from './rpc.js';
import { AddressSpaceKind, IAddressSpace } from '../common/address.js';
import { TargetCapability } from '../common/capabilities.js';
import { IDelverTarget, ITargetDescriptor, TargetConfig } from '../common/target.js';
import {
	AddressSpaceKindWire,
	IAddressSpaceWire,
	IGetImageInfoResult,
	IInitializeResult,
	IListSpacesResult,
	ITargetDescriptorWire,
	TargetCapabilityWire,
} from '../common/protocol.generated.js';
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

	private constructor(
		child: ChildProcessWithoutNullStreams,
		rpc: DelverRpcClient,
		init: IInitializeResult,
	) {
		this.child = child;
		this.rpc = rpc;
		this.descriptor = descriptorFromWire(init.target);
		this.capabilities = Object.freeze(init.capabilities.map(capFromWire));
		this.spaces = Object.freeze(init.spaces.map(spaceFromWire));

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
		const binaryPath = resolveBinary(binaryName);

		const child = spawn(binaryPath, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const rpc = new DelverRpcClient({ reader: child.stdout, writer: child.stdin });

		try {
			const { json } = await rpc.call('initialize', null);
			const init = json.result as IInitializeResult;
			return new DelverProviderProcess(child, rpc, init);
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
		return result.spaces.map(spaceFromWire);
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

function descriptorFromWire(wire: ITargetDescriptorWire): ITargetDescriptor {
	return { name: wire.name, kind: wire.kind };
}

function capFromWire(wire: TargetCapabilityWire): TargetCapability {
	switch (wire) {
		case TargetCapabilityWire.ListSpaces: return TargetCapability.ListSpaces;
		case TargetCapabilityWire.GetImageInfo: return TargetCapability.GetImageInfo;
		case TargetCapabilityWire.ReadMemory: return TargetCapability.ReadMemory;
		case TargetCapabilityWire.GetImports: return TargetCapability.GetImports;
		case TargetCapabilityWire.GetExports: return TargetCapability.GetExports;
		case TargetCapabilityWire.GetFunctionSeeds: return TargetCapability.GetFunctionSeeds;
		case TargetCapabilityWire.Analyze: return TargetCapability.Analyze;
		default: throw new Error(`Unknown capability: ${wire}`);
	}
}

function spaceFromWire(wire: IAddressSpaceWire): IAddressSpace {
	return {
		id: wire.id,
		kind: kindFromWire(wire.kind),
		pointerWidth: wire.pointer_width,
		size: BigInt(wire.size),
		translatesTo: wire.translates_to,
	};
}

function kindFromWire(wire: AddressSpaceKindWire): AddressSpaceKind {
	switch (wire) {
		case AddressSpaceKindWire.File: return AddressSpaceKind.File;
		case AddressSpaceKindWire.Image: return AddressSpaceKind.Image;
		default: throw new Error(`Unknown address space kind: ${wire}`);
	}
}
