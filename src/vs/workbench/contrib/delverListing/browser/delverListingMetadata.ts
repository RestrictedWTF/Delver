/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IGetImageInfoResult, ISectionWire } from '../../../../platform/delver/common/protocol.generated.js';

/** Formats an instruction RVA with the section that owns it. */
export function listingAddressLabel(rva: string, sections: readonly ISectionWire[]): string {
	return `${sectionForAddress(rva, sections)?.name ?? 'image'}:${rva}`;
}

/** Builds the compact, IDA-style target summary shown above the listing. */
export function listingMetadata(targetPath: string, info: IGetImageInfoResult): string {
	const metadata = listingMetadataRow(targetPath, info);
	return metadata.lines.map(line => `${metadata.address} ${line}`).join('\n');
}

export interface IListingMetadataRow {
	readonly address: string;
	readonly lines: readonly string[];
}

/** Builds one scrollable, multi-line metadata row for the composite listing. */
export function listingMetadataRow(targetPath: string, info: IGetImageInfoResult): IListingMetadataRow {
	const prefix = listingAddressLabel(info.sections[0]?.virtual_address ?? info.entry, info.sections);
	const lines = [
		localize('delverListingMetadataHash', "; Input SHA256 : {0}", info.content_hash.toUpperCase()),
		localize('delverListingMetadataFile', "; File Name    : {0}", targetPath),
		localize('delverListingMetadataArchitecture', "; Architecture : {0}", info.arch),
		localize('delverListingMetadataImageBase', "; Image Base   : {0}", info.image_base),
		localize('delverListingMetadataEntry', "; Entry Point  : {0}", info.entry),
	];

	for (const [index, section] of info.sections.entries()) {
		lines.push(localize(
			'delverListingMetadataSection',
			"; Section {0}: {1} | VA {2} | virtual {3} bytes | raw {4} bytes at {5} | {6}",
			index + 1,
			section.name,
			section.virtual_address,
			section.virtual_size,
			section.raw_size,
			section.raw_offset,
			sectionPermissions(section),
		));
	}

	return { address: prefix, lines };
}

function sectionForAddress(rva: string, sections: readonly ISectionWire[]): ISectionWire | undefined {
	let address: bigint;
	try {
		address = BigInt(rva);
	} catch {
		return undefined;
	}
	return sections.find(section => {
		const start = BigInt(section.virtual_address);
		return start <= address && address < start + BigInt(section.virtual_size);
	});
}

function sectionPermissions(section: ISectionWire): string {
	return (section.readable ? 'R' : '-')
		+ (section.writable ? 'W' : '-')
		+ (section.executable ? 'X' : '-');
}
