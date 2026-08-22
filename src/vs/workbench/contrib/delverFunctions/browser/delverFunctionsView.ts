/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { functionDisplayName } from '../../../../platform/delver/common/naming.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';

export const DELVER_FUNCTIONS_VIEW_ID = 'delver.view.functions';
export const DELVER_FUNCTIONS_OPEN_COMMAND = 'delver.functions.goTo';
export const DELVER_FUNCTION_HANDLE_PREFIX = 'delver.function.';

/** Maximum function rows materialized by one expanded tree node. */
export const FUNCTION_PAGE_SIZE = 1_000;

const VOUCHED_HANDLE = 'delver.functions.vouched';
const SWEPT_HANDLE = 'delver.functions.swept';
const FILTERED_HANDLE_SUFFIX = '.filtered';
const PAGE_PREFIX = 'delver.functions.page.';

export class DelverFunctionsTreeDataProvider implements ITreeViewDataProvider {
	private vouched: readonly IFunctionWire[] = [];
	private swept: readonly IFunctionWire[] = [];
	private visibleVouched: readonly IFunctionWire[] = [];
	private visibleSwept: readonly IFunctionWire[] = [];
	private loaded = false;
	private names = new Map<string, string>();
	private filter = '';

	get isFiltered(): boolean {
		return this.filter !== '';
	}

	setFunctions(functions: readonly IFunctionWire[] | undefined): void {
		this.loaded = functions !== undefined;
		this.vouched = functions?.filter(fn => fn.authoritative) ?? [];
		this.swept = functions?.filter(fn => !fn.authoritative) ?? [];
		this.rebuildVisible();
	}

	setNames(names: Map<string, string>): void {
		this.names = names;
		if (this.filter) {
			this.rebuildVisible();
		}
	}

	setFilter(query: string): void {
		this.filter = query.trim().toLowerCase();
		this.rebuildVisible();
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (!this.loaded) {
			return [];
		}
		if (!element) {
			return [
				group(
					this.filter ? VOUCHED_HANDLE + FILTERED_HANDLE_SUFFIX : VOUCHED_HANDLE,
					localize('delverFunctionsVouched', "Compiler-vouched"),
					this.visibleVouched.length,
					TreeItemCollapsibleState.Expanded,
				),
				group(
					this.filter ? SWEPT_HANDLE + FILTERED_HANDLE_SUFFIX : SWEPT_HANDLE,
					localize('delverFunctionsSwept', "Found by sweep"),
					this.visibleSwept.length,
					this.filter ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed,
				),
			];
		}
		if (element.handle === VOUCHED_HANDLE || element.handle === VOUCHED_HANDLE + FILTERED_HANDLE_SUFFIX) {
			return categoryChildren('vouched', this.visibleVouched, this.names);
		}
		if (element.handle === SWEPT_HANDLE || element.handle === SWEPT_HANDLE + FILTERED_HANDLE_SUFFIX) {
			return categoryChildren('swept', this.visibleSwept, this.names);
		}
		const page = parsePageHandle(element.handle);
		if (!page) {
			return [];
		}
		const source = page.category === 'vouched' ? this.visibleVouched : this.visibleSwept;
		return source
			.slice(page.start, page.start + FUNCTION_PAGE_SIZE)
			.map(fn => functionItem(fn, this.names.get(fn.rva)));
	}

	private rebuildVisible(): void {
		if (!this.filter) {
			this.visibleVouched = this.vouched;
			this.visibleSwept = this.swept;
			return;
		}
		const matches = (fn: IFunctionWire) => {
			const name = functionDisplayName(BigInt(fn.rva), this.names.get(fn.rva));
			return name.toLowerCase().includes(this.filter)
				|| fn.rva.toLowerCase().includes(this.filter)
				|| functionSourceSearchText(fn.source).includes(this.filter);
		};
		this.visibleVouched = this.vouched.filter(matches);
		this.visibleSwept = this.swept.filter(matches);
	}
}

function group(handle: string, label: string, count: number, state: TreeItemCollapsibleState): ITreeItem {
	return {
		handle,
		label: { label },
		description: String(count),
		collapsibleState: count > 0 ? state : TreeItemCollapsibleState.None,
	};
}

function categoryChildren(
	category: 'vouched' | 'swept',
	functions: readonly IFunctionWire[],
	names: ReadonlyMap<string, string>,
): readonly ITreeItem[] {
	if (functions.length <= FUNCTION_PAGE_SIZE) {
		return functions.map(fn => functionItem(fn, names.get(fn.rva)));
	}
	const pages: ITreeItem[] = [];
	for (let start = 0; start < functions.length; start += FUNCTION_PAGE_SIZE) {
		const end = Math.min(functions.length, start + FUNCTION_PAGE_SIZE);
		pages.push({
			handle: `${PAGE_PREFIX}${category}.${start}`,
			label: { label: localize('delverFunctionPage', "Functions {0}-{1}", start + 1, end) },
			description: `${functions[start].rva}-${functions[end - 1].rva}`,
			themeIcon: ThemeIcon.fromId(Codicon.listTree.id),
			collapsibleState: TreeItemCollapsibleState.Collapsed,
		});
	}
	return pages;
}

function functionItem(fn: IFunctionWire, name: string | undefined): ITreeItem {
	return {
		handle: `${DELVER_FUNCTION_HANDLE_PREFIX}${fn.rva}`,
		contextValue: 'delver-function',
		label: { label: functionDisplayName(BigInt(fn.rva), name) },
		description: `${fn.rva}  ${describe(fn.source)}`,
		themeIcon: ThemeIcon.fromId(fn.authoritative ? Codicon.symbolFunction.id : Codicon.symbolMisc.id),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_FUNCTIONS_OPEN_COMMAND,
			title: localize('delverFunctionOpenPseudocode', "Open Pseudocode"),
			arguments: [fn.rva],
		},
	};
}

export function functionRvaFromHandle(handle: string): bigint | undefined {
	if (!handle.startsWith(DELVER_FUNCTION_HANDLE_PREFIX)) {
		return undefined;
	}
	try {
		return BigInt(handle.slice(DELVER_FUNCTION_HANDLE_PREFIX.length));
	} catch {
		return undefined;
	}
}

function parsePageHandle(handle: string): { category: 'vouched' | 'swept'; start: number } | undefined {
	const match = /^delver\.functions\.page\.(vouched|swept)\.(\d+)$/.exec(handle);
	return match ? { category: match[1] as 'vouched' | 'swept', start: Number(match[2]) } : undefined;
}

function describe(source: FunctionSourceWire): string {
	switch (source) {
		case FunctionSourceWire.ExceptionDirectory: return localize('delverFnException', "exception directory");
		case FunctionSourceWire.EntryPoint: return localize('delverFnEntry', "entry point");
		case FunctionSourceWire.Export: return localize('delverFnExport', "export");
		case FunctionSourceWire.TlsCallback: return localize('delverFnTls', "TLS callback");
		case FunctionSourceWire.CallTarget: return localize('delverFnCall', "called");
		case FunctionSourceWire.LinearSweep: return localize('delverFnSweep', "guess");
		default: return '';
	}
}

function functionSourceSearchText(source: FunctionSourceWire): string {
	return `${source} ${describe(source)}`.toLowerCase();
}
