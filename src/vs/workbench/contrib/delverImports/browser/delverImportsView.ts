/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import {
	IGetImportsResult,
	IImportedModuleWire,
	IImportedSymbolWire,
} from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';

export const DELVER_IMPORTS_VIEW_ID = 'delver.view.imports';

/** Command invoked when an imported symbol is clicked. */
export const DELVER_IMPORTS_OPEN_COMMAND = 'delver.imports.goTo';

/**
 * Two levels: module, then the symbols taken from it.
 *
 * Grouping by module is not cosmetic — what a binary imports *from where* is the
 * fastest read available on an unknown file, and a flat list of six hundred
 * symbols destroys exactly that signal.
 */
export class DelverImportsTreeDataProvider implements ITreeViewDataProvider {
	private result: IGetImportsResult | undefined;
	private visible: readonly IVisibleModule[] = [];
	private filter = '';

	setImports(result: IGetImportsResult | undefined): void {
		this.result = result;
		this.rebuildVisible();
	}

	setFilter(query: string): void {
		this.filter = query.trim().toLowerCase();
		this.rebuildVisible();
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (!this.result) {
			return [];
		}

		if (!element) {
			return this.visible.map(entry => moduleItem(entry, this.filter !== ''));
		}

		const index = moduleIndexOf(element.handle);
		const entry = index === undefined ? undefined : this.visible.find(module => module.index === index);
		return entry ? entry.symbols.map((symbol, i) => symbolItem(symbol, entry.index, i)) : [];
	}

	private rebuildVisible(): void {
		const modules = this.result?.modules ?? [];
		this.visible = modules.flatMap((module, index): IVisibleModule[] => {
			if (!this.filter || module.name.toLowerCase().includes(this.filter)) {
				return [{ module, index, symbols: module.symbols }];
			}
			const symbols = module.symbols.filter(symbol => importSearchText(symbol).includes(this.filter));
			return symbols.length > 0 ? [{ module, index, symbols }] : [];
		});
	}
}

interface IVisibleModule {
	readonly module: IImportedModuleWire;
	readonly index: number;
	readonly symbols: readonly IImportedSymbolWire[];
}

function moduleItem(entry: IVisibleModule, filtered: boolean): ITreeItem {
	return {
		handle: `delver.import.module.${entry.index}`,
		label: { label: entry.module.name },
		description: localize('delverImportSymbolCount', "{0} symbols", entry.symbols.length),
		themeIcon: ThemeIcon.fromId(Codicon.library.id),
		// Modules start collapsed: the point of this pane at a glance is *which*
		// libraries are used, and expanding everything buries that under symbols.
		collapsibleState: entry.symbols.length > 0
			? (filtered ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed)
			: TreeItemCollapsibleState.None,
	};
}

function importSearchText(symbol: IImportedSymbolWire): string {
	return `${symbol.name ?? ''} ${symbol.ordinal ?? ''} ${symbol.iat_rva}`.toLowerCase();
}

function symbolItem(symbol: IImportedSymbolWire, moduleIndex: number, index: number): ITreeItem {
	// Imports by ordinal have no name. Showing the ordinal is the honest answer;
	// inventing a label would suggest a name the file does not carry.
	const label = symbol.name
		?? localize('delverImportOrdinal', "Ordinal {0}", symbol.ordinal ?? 0);

	return {
		handle: `delver.import.symbol.${moduleIndex}.${index}.${symbol.iat_rva}`,
		label: { label },
		contextValue: 'delver-import-symbol',
		// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
		// arrived. This is the IAT slot a call site indirects through, which is
		// what makes the symbol navigable at all.
		description: symbol.iat_rva,
		themeIcon: ThemeIcon.fromId(Codicon.symbolFunction.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_IMPORTS_OPEN_COMMAND,
			title: localize('delverImportGoTo', "Go to Import"),
			arguments: [symbol.iat_rva],
		},
	};
}

function moduleIndexOf(handle: string): number | undefined {
	const parsed = Number(handle.slice('delver.import.module.'.length));
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
