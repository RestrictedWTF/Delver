/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What to call something that nobody has named yet.
 *
 * **A placeholder is not an authored name.** It is never written to the
 * interpretation log: doing so would attribute a machine-generated label to an
 * analyst, and the whole value of that log is that everything in it was
 * genuinely decided by someone. `SUB_1000` means "nobody has looked at
 * this", and it has to keep meaning that.
 *
 * Delver uses image-relative addresses so generated names remain stable when
 * an image is rebased. The upper-case `SUB_` spelling also keeps generated
 * names visually distinct from authored names.
 */

/** Formats an RVA the way placeholder names do: bare uppercase hex, no `0x`. */
function bareHex(rva: bigint): string {
	return rva.toString(16).toUpperCase();
}

/** Placeholder for a function entry, e.g. `SUB_1000`. */
export function placeholderFunctionName(rva: bigint): string {
	return `SUB_${bareHex(rva)}`;
}

/** Placeholder for a labelled address that is not a function entry. */
export function placeholderLocationName(rva: bigint): string {
	return `loc_${bareHex(rva)}`;
}

/**
 * What to display for a function: the authored name if there is one, otherwise
 * a placeholder.
 *
 * An empty authored name is treated as absent — clearing a name restores the
 * placeholder rather than leaving a blank row.
 */
export function functionDisplayName(rva: bigint, authored: string | undefined): string {
	return authored ? authored : placeholderFunctionName(rva);
}

/** Whether `name` is a placeholder this module produced rather than authored text. */
export function isPlaceholderName(name: string): boolean {
	// Lower-case sub_ is retained for project/log compatibility with builds
	// created before Delver standardized its generated function spelling.
	return /^(?:SUB|sub|loc)_[0-9A-F]+$/.test(name);
}
