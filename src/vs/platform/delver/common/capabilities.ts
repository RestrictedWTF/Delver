/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capabilities a target may expose. UI and analysis code branch on these,
 * never on target kind.
 */
export const enum TargetCapability {
	ListSpaces = 'listSpaces',
	GetImageInfo = 'getImageInfo',
	ReadMemory = 'readMemory',
	GetImports = 'getImports',
	GetExports = 'getExports',
	GetFunctionSeeds = 'getFunctionSeeds',
	Analyze = 'analyze',
}

/**
 * Returns true if the capability set includes the given capability.
 */
export function hasCapability(capabilities: readonly TargetCapability[], capability: TargetCapability): boolean {
	return capabilities.includes(capability);
}
