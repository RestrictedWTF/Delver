/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

/**
 * The zone name in a workspace zone header.
 *
 * Navigator, Primary and Inspector are the workspace's fixed frame — the thing
 * an analyst orients by before reading anything. They carry the product accent
 * for the same reason the function landmark does (`principles.md` §3): they are
 * not a kind of content, they are the boundary between content.
 *
 * Deliberately the same hue as `delver.listing.functionName`, so the accent
 * reads as one product signal rather than two competing ones.
 */
export const delverZoneTitle = registerColor('delver.zone.title',
	{ dark: '#ff9648', light: '#b3560d', hcDark: '#ffab6b', hcLight: '#8a3f05' },
	localize('delver.zone.title', "Foreground color of a Delver workspace zone's name in its header."));
