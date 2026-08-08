/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

/**
 * The function landmark line in the listing.
 *
 * A function start is the one place in a scrolling listing where the eye needs
 * to stop, so it is the only listing element given the product accent rather
 * than a role from the semantic palette. Borrowing
 * `symbolIcon.functionForeground` put it in the same family as the operands
 * around it, which is exactly what a landmark must not be.
 */
export const delverListingFunctionName = registerColor('delver.listing.functionName',
	{ dark: '#ff9648', light: '#b3560d', hcDark: '#ffab6b', hcLight: '#8a3f05' },
	localize('delver.listing.functionName', "Foreground color of the function name on a function's landmark line in the listing."));
