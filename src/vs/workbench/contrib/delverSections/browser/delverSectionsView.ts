/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { IGetImageInfoResult, ISectionWire } from '../../../../platform/delver/common/protocol.generated.js';

export const DELVER_SECTIONS_VIEW_ID = 'delver.view.sections';

/** Command invoked when a section is clicked. */
export const DELVER_SECTIONS_OPEN_COMMAND = 'delver.sections.goTo';

/**
 * Entropy above which raw bytes look compressed or encrypted rather than
 * compiled.
 *
 * Machine code sits near 6 bits per byte; packed and ciphered data crowd 8.
 * This is a hint, not a verdict — a legitimate section full of compressed
 * resources will trip it too — so it is surfaced as a flag to look at, never as
 * a conclusion.
 */
const HIGH_ENTROPY = 7.0;

export interface IDelverSectionTreeItem extends ITreeItem {
	readonly section: ISectionWire;
}

/**
 * Builds tree items for the sections of the currently open image.
 */
export class DelverSectionsTreeDataProvider implements ITreeViewDataProvider {
	private info: IGetImageInfoResult | undefined;

	setImageInfo(info: IGetImageInfoResult | undefined): void {
		this.info = info;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (element || !this.info) {
			return [];
		}
		return this.info.sections.map(sectionItem);
	}
}

function sectionItem(section: ISectionWire, index: number): IDelverSectionTreeItem {
	const suspicious = isSuspicious(section);

	return {
		handle: `delver.section.${index}`,
		label: { label: section.name },
		// Permissions first: what a section is allowed to do says more about it
		// than where it happens to live.
		description: `${permissions(section)}  ${section.entropy.toFixed(2)}  ${section.virtual_address}`,
		themeIcon: ThemeIcon.fromId(
			suspicious ? Codicon.warning.id
				: section.executable ? Codicon.symbolMethod.id
					: Codicon.symbolField.id,
		),
		tooltip: tooltipFor(section, suspicious),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_SECTIONS_OPEN_COMMAND,
			title: localize('delverSectionGoTo', "Go to Section"),
			arguments: [section.virtual_address],
		},
		section,
	};
}

/**
 * Whether a section is worth a second look.
 *
 * Writable **and** executable is the strong one: compilers do not emit it and
 * packers routinely need it. High entropy in code is the other — compiled
 * instructions are not that random unless something has compressed them.
 */
function isSuspicious(section: ISectionWire): boolean {
	return (section.writable && section.executable)
		|| (section.executable && section.entropy >= HIGH_ENTROPY);
}

function permissions(section: ISectionWire): string {
	// Fixed-width so the column stays readable down the list, with '-' for an
	// absent permission rather than a gap.
	return (section.readable ? 'R' : '-')
		+ (section.writable ? 'W' : '-')
		+ (section.executable ? 'X' : '-');
}

function tooltipFor(section: ISectionWire, suspicious: boolean): string {
	// Addresses arrive as "0x..." strings (ADR 0001), so they already carry
	// their prefix — do not add another one.
	const base = localize(
		'delverSectionTooltip',
		"{0}\nVA: {1} ({2} bytes)\nRaw: {3} ({4} bytes)\nPermissions: {5}\nEntropy: {6} bits/byte",
		section.name,
		section.virtual_address,
		section.virtual_size,
		section.raw_offset,
		section.raw_size,
		permissions(section),
		section.entropy.toFixed(2),
	);

	if (!suspicious) {
		return base;
	}

	const reason = section.writable && section.executable
		? localize('delverSectionWx', "Writable and executable — compilers do not emit this; packers need it.")
		: localize('delverSectionHighEntropy', "Executable with high entropy — the bytes look compressed or encrypted rather than compiled.");

	return `${base}\n\n${reason}`;
}
