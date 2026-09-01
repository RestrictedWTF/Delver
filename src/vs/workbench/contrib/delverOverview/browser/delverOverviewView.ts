/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IGetImageInfoResult, IOpenImageResult } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { DelverSurfaceId } from '../../../services/delver/browser/delverSurface.js';

export const DELVER_OVERVIEW_GO_TO_COMMAND = 'delver.overview.goTo';
export const DELVER_OVERVIEW_REVEAL_COMMAND = 'delver.overview.revealView';

interface IOverviewRow {
	readonly label: string;
	readonly value: string;
	readonly icon: string;
	readonly command?: { readonly id: string; readonly args: unknown[] };
	/** Long-form reason, shown on hover. Only completeness rows carry one. */
	readonly tooltip?: string;
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
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: [DelverSurfaceId.Functions] },
			},
			{
				label: localize('delverOverviewXrefs', "References"),
				value: count(this.image.xref_count),
				icon: Codicon.references.id,
				command: { id: DELVER_OVERVIEW_REVEAL_COMMAND, args: [DelverSurfaceId.Xrefs] },
			},
			{
				label: localize('delverOverviewStrings', "Strings"),
				value: count(this.image.string_count),
				icon: Codicon.symbolString.id,
				command: { id: 'delver.strings.open', args: [] },
			},
		];

		rows.push(...completenessRows(this.info));

		return rows.map((row, index) => ({
			handle: `delver.overview.${index}`,
			label: { label: row.label },
			description: row.value,
			themeIcon: ThemeIcon.fromId(row.icon),
			tooltip: row.tooltip,
			collapsibleState: TreeItemCollapsibleState.None,
			command: row.command === undefined ? undefined : {
				id: row.command.id,
				title: row.label,
				arguments: row.command.args,
			},
		}));
	}
}

/**
 * Rows for the parse-completeness flags on `getImageInfo`.
 *
 * A count is only a fact about the sample when the parse that produced it ran
 * to the end. Where it did not, the number is what was *recovered*, and
 * printing it plain tells an analyst that a packed binary calls no APIs
 * (`Docs/design/principles.md` section 1). So each set flag gets its own row,
 * naming the count and the specific reason it is short — a truncation and a
 * failure are different facts and never share a row.
 *
 * A fully parsed image produces none of these, and the pane reads as before.
 */
function completenessRows(info: IGetImageInfoResult): IOverviewRow[] {
	const rows: IOverviewRow[] = [];
	// Labels are hoisted so two rows about the same count (a failure and a
	// truncation) share one localization key rather than duplicating it.
	const imports = localize('delverOverviewImports', "Imports");
	const exports = localize('delverOverviewExports', "Exports");
	const seeds = localize('delverOverviewSeeds', "Function seeds");
	const relocations = localize('delverOverviewRelocations', "Relocations");
	const add = (label: string, value: string, tooltip: string) => {
		rows.push({ label, value, tooltip, icon: Codicon.warning.id });
	};

	if (info.imports_failed) {
		add(
			imports,
			localize('delverOverviewImportsFailed', "{0} recovered — import directory parse failed", count(info.import_module_count)),
			localize('delverOverviewImportsFailedDetail', "The import directory is present but could not be parsed to the end. {0} module(s) were recovered before it gave up; that is not the image's import list.", count(info.import_module_count)),
		);
	}
	if (info.imports_truncated) {
		add(
			imports,
			localize('delverOverviewImportsTruncated', "{0} recovered — module cap reached", count(info.import_module_count)),
			localize('delverOverviewImportsTruncatedDetail', "Modules were dropped at the parser's module cap. The image imports at least the {0} shown, and possibly many more.", count(info.import_module_count)),
		);
	}
	if (info.exports_failed) {
		add(
			exports,
			localize('delverOverviewExportsFailed', "{0} recovered — export directory parse failed", count(info.export_count)),
			localize('delverOverviewExportsFailedDetail', "The export directory is present but could not be parsed. {0} export(s) were recovered first; an empty list here is not a claim that the image exports nothing.", count(info.export_count)),
		);
	}
	if (info.exports_truncated) {
		add(
			exports,
			localize('delverOverviewExportsTruncated', "{0} recovered — export cap reached", count(info.export_count)),
			localize('delverOverviewExportsTruncatedDetail', "Exports were dropped at the parser's export cap. The image exports at least the {0} shown.", count(info.export_count)),
		);
	}
	if (info.exception_directory_failed) {
		add(
			seeds,
			localize('delverOverviewSeedsFailed', "{0} recovered — exception directory unreadable", count(info.function_seed_count)),
			localize('delverOverviewSeedsFailedDetail', "The exception directory is present but could not be read whole, so compiler-emitted function starts are missing — on x64 the most authoritative starts the image has. Detected functions and extents are poorer as a result."),
		);
	}
	if (info.function_seeds_truncated) {
		add(
			seeds,
			localize('delverOverviewSeedsTruncated', "{0} recovered — seed cap reached", count(info.function_seed_count)),
			localize('delverOverviewSeedsTruncatedDetail', "Exception-directory seeds were dropped at the parser's seed cap. The image declares at least the {0} shown.", count(info.function_seed_count)),
		);
	}
	if (info.relocations_failed) {
		add(
			relocations,
			localize('delverOverviewRelocationsFailed', "{0} recovered — relocation directory parse failed", count(info.relocation_count)),
			localize('delverOverviewRelocationsFailedDetail', "The relocation directory is present but could not be parsed to the end. {0} target(s) were recovered first; do not read this as \"the image cannot be rebased\".", count(info.relocation_count)),
		);
	}
	if (info.relocations_truncated) {
		add(
			relocations,
			localize('delverOverviewRelocationsTruncated', "{0} recovered — relocation cap reached", count(info.relocation_count)),
			localize('delverOverviewRelocationsTruncatedDetail', "Relocation targets were dropped at the parser's relocation cap. The image relocates at least the {0} shown.", count(info.relocation_count)),
		);
	}
	if (info.tls_failed) {
		add(
			localize('delverOverviewTls', "TLS directory"),
			localize('delverOverviewTlsFailed', "Present, parse failed"),
			localize('delverOverviewTlsFailedDetail', "The TLS directory is present but could not be parsed, so no callbacks are listed for a reason that is not \"the image has none\". TLS callbacks run before the entry point, which is exactly why anti-analysis code hides there."),
		);
	}
	if (info.section_names_unreadable) {
		add(
			localize('delverOverviewSections', "Section names"),
			localize('delverOverviewSectionsUnreadable', "At least one name undecodable"),
			localize('delverOverviewSectionsUnreadableDetail', "At least one section header carries a name that could not be decoded. Those sections report an empty name, which is not the name they have."),
		);
	}

	// `fully_parsed` also folds in per-module, per-symbol and TLS-callback flags
	// that `getImageInfo` does not carry. When it is false and nothing above
	// fired, one of those is set — say so rather than showing a clean pane.
	if (!info.fully_parsed && rows.length === 0) {
		add(
			localize('delverOverviewParse', "Parse"),
			localize('delverOverviewParseIncomplete', "Incomplete — see Imports and TLS"),
			localize('delverOverviewParseIncompleteDetail', "The parse did not run to the end, but the reason sits on an individual module, symbol or TLS callback rather than on the image. Open the Imports and TLS surfaces for the specific entry."),
		);
	}

	return rows;
}

function count(value: number): string {
	return value.toLocaleString();
}

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return separator === -1 ? path : path.slice(separator + 1);
}
