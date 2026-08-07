/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AddressSpaceKind, IAddressSpace } from './address.js';
import { TargetCapability } from './capabilities.js';
import {
	AddressSpaceKindWire,
	IAddressSpaceWire,
	ITargetDescriptorWire,
	TargetCapabilityWire,
} from './protocol.generated.js';
import { ITargetDescriptor } from './target.js';

/**
 * Wire → domain conversions.
 *
 * These live in `common/` rather than beside the provider host because DTP is
 * not the only wire in the system: target state also crosses the
 * shared-process → renderer IPC boundary, and it crosses it in wire form for
 * the same reason it does over DTP (see {@link IDelverTargetSnapshot}). Both
 * sides need the same conversion, so it cannot live in `node/`.
 */

export function descriptorFromWire(wire: ITargetDescriptorWire): ITargetDescriptor {
	return { name: wire.name, kind: wire.kind };
}

/**
 * Maps advertised capabilities, **dropping any this build does not know**.
 *
 * A provider is a separately built binary and may be newer than the workbench.
 * Rejecting an unrecognised capability would fail the whole attach over a
 * feature the caller was never going to ask for; capability negotiation is
 * supposed to degrade, not abort.
 */
export function capabilitiesFromWire(wire: readonly TargetCapabilityWire[]): TargetCapability[] {
	const known: TargetCapability[] = [];
	for (const capability of wire) {
		const mapped = capabilityFromWire(capability);
		if (mapped !== undefined) {
			known.push(mapped);
		}
	}
	return known;
}

function capabilityFromWire(wire: TargetCapabilityWire): TargetCapability | undefined {
	switch (wire) {
		case TargetCapabilityWire.ListSpaces: return TargetCapability.ListSpaces;
		case TargetCapabilityWire.GetImageInfo: return TargetCapability.GetImageInfo;
		case TargetCapabilityWire.ReadMemory: return TargetCapability.ReadMemory;
		case TargetCapabilityWire.GetImports: return TargetCapability.GetImports;
		case TargetCapabilityWire.GetExports: return TargetCapability.GetExports;
		case TargetCapabilityWire.GetFunctionSeeds: return TargetCapability.GetFunctionSeeds;
		case TargetCapabilityWire.Analyze: return TargetCapability.Analyze;
		default: return undefined;
	}
}

export function addressSpaceFromWire(wire: IAddressSpaceWire): IAddressSpace {
	return {
		id: wire.id,
		kind: addressSpaceKindFromWire(wire.kind),
		pointerWidth: wire.pointer_width,
		// Sizes arrive as "0x..." strings (ADR 0001); `BigInt` parses the
		// prefix directly, and going via `Number` would truncate above 2^53.
		size: BigInt(wire.size),
		translatesTo: wire.translates_to,
	};
}

function addressSpaceKindFromWire(wire: AddressSpaceKindWire): AddressSpaceKind {
	switch (wire) {
		case AddressSpaceKindWire.File: return AddressSpaceKind.File;
		case AddressSpaceKindWire.Image: return AddressSpaceKind.Image;
		default: throw new Error(`Unknown address space kind: ${wire}`);
	}
}
