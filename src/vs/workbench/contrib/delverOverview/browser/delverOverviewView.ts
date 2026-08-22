/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IGetImageInfoResult, IOpenImageResult } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';

export const DELVER_OVERVIEW_GO_TO_COMMAND = 'delver.overview.goTo';
export const DELVER_OVERVIEW_REVEAL_COMMAND = 'delver.overview.revealView';

interface IOverviewRow {
	readonly label: string;
	readonly value: string;
	readonly icon: string;
	readonly command?: { readonly id: string; readonly args: unknown[] };
}

/** Provides the actionable summary rows shown in the Overview pane. */
export class DelverOverviewTreeDataProvider implements ITreeViewDataProvider {
	private info: IGetImageInfoResult | undefined;
	private image: IOpenImageResult | undefined;
	private targetPath: string | undefined;

	setContent(targetPath: string | undefined, image: IOpenImageResult | undefined, info: IGetImageInfoResult | undefined): void {
		this.targetPath = targetPath;
		this.image = image;
		this.info = info;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (element || !this.image || !this.info) {
			return [];
		}

		// Every row that can lead somewhere does. Overview is the first thing you
		// read after opening a target, so it works better as a table of contents
		// than as a readout you look at once and never touch again.
		const rows: IOverviewRow[] = [
			{ label: localize('delverOverviewFile', "File"), value: basename(this.targetPath ?? ''), icon: Codicon.fileBinary.id },
			{ label: localize('delverOverviewArch', "Architecture"), value: this.info.arch, icon: Codicon.chip.id },
			// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
			// arrived; re-formatting through a number would truncate above 2^53.
			{
				label: localize('delverOverviewEntry', "Entry point"),
				value: this.info.entry,
				icon: Codicon.debugStart.id,
				command: { id: DELVER_OVERVIEW_GO_TO_COMMAND, args: [this.info.entry] },
			},
			{ label: localize('delverOverviewBase', "Image base"), value: this.info.image_base, icon: Codicon.milestone.id },
			{
				label: localize('delverOverviewInstructions', "Instructions"),
				value: count(this.image.instruction_count),
				icon: Codicon.listOrdered.id,
				command: { id: 'delver.listing.openCurrent', args: [] },
			},
			{
				label: localize('delverOverviewFunctions', "Functions"),
				value: count(this.image.function_count),
				icon: Codicon.symbolFunction.id,
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: ['delver.view.functions'] },
			},
			{
				label: localize('delverOverviewXrefs', "References"),
				value: count(this.image.xref_count),
				icon: Codicon.references.id,
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: ['delver.view.xrefs'] },
			},
			{
				label: localize('delverOverviewStrings', "Strings"),
				value: count(this.image.string_count),
				icon: Codicon.symbolString.id,
				command: { id: 'delver.strings.open', args: [] },
			},
		];

		return rows.map((row, index) => ({
			handle: `delver.overview.${index}`,
			label: { label: row.label },
			description: row.value,
			themeIcon: ThemeIcon.fromId(row.icon),
			collapsibleState: TreeItemCollapsibleState.None,
			command: row.command === undefined ? undefined : {
				id: row.command.id,
				title: row.label,
				arguments: row.command.args,
			},
		}));
	}
}

function count(value: number): string {
	return value.toLocaleString();
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}
