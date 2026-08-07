/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { FunctionSourceWire, IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';

export const DELVER_FUNCTIONS_VIEW_ID = 'delver.view.functions';

/** Command invoked when a function is clicked. */
export const DELVER_FUNCTIONS_OPEN_COMMAND = 'delver.functions.goTo';

/**
 * How many swept functions the pane will list.
 *
 * A large module sweeps up ~178k guesses. Rendering them is possible but
 * pointless: nobody finds a function by scrolling past a hundred thousand
 * addresses, and the cost is paid on every refresh. The list is capped and says
 * so, which is more honest than silently stopping.
 */
const SWEPT_LIMIT = 1_000;

const VOUCHED_HANDLE = 'delver.functions.vouched';
const SWEPT_HANDLE = 'delver.functions.swept';

export class DelverFunctionsTreeDataProvider implements ITreeViewDataProvider {
	private vouched: readonly IFunctionWire[] = [];
	private swept: readonly IFunctionWire[] = [];
	private loaded = false;

	setFunctions(functions: readonly IFunctionWire[] | undefined): void {
		this.loaded = functions !== undefined;
		this.vouched = functions?.filter(f => f.authoritative) ?? [];
		this.swept = functions?.filter(f => !f.authoritative) ?? [];
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		if (!this.loaded) {
			return [];
		}

		if (!element) {
			return [
				// The split is the point of this pane. A boundary the image
				// vouches for and one a sweep guessed at are different kinds of
				// claim, and presenting them in one list would flatten that.
				group(
					VOUCHED_HANDLE,
					localize('delverFunctionsVouched', "Compiler-vouched"),
					this.vouched.length,
					TreeItemCollapsibleState.Expanded,
				),
				group(
					SWEPT_HANDLE,
					localize('delverFunctionsSwept', "Found by sweep"),
					this.swept.length,
					TreeItemCollapsibleState.Collapsed,
				),
			];
		}

		if (element.handle === VOUCHED_HANDLE) {
			return this.vouched.map((fn, i) => functionItem(fn, `v${i}`));
		}
		if (element.handle === SWEPT_HANDLE) {
			const shown = this.swept.slice(0, SWEPT_LIMIT).map((fn, i) => functionItem(fn, `s${i}`));
			if (this.swept.length > SWEPT_LIMIT) {
				shown.push(overflowItem(this.swept.length - SWEPT_LIMIT));
			}
			return shown;
		}
		return [];
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

function functionItem(fn: IFunctionWire, id: string): ITreeItem {
	// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
	// arrived. There is nothing else to call a function yet — names arrive with
	// the interpretation layer.
	return {
		handle: `delver.function.${id}`,
		label: { label: fn.rva },
		description: describe(fn.source),
		themeIcon: ThemeIcon.fromId(
			fn.authoritative ? Codicon.symbolFunction.id : Codicon.symbolMisc.id,
		),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_FUNCTIONS_OPEN_COMMAND,
			title: localize('delverFunctionGoTo', "Go to Function"),
			arguments: [fn.rva],
		},
	};
}

function overflowItem(remaining: number): ITreeItem {
	return {
		handle: 'delver.functions.overflow',
		label: {
			label: localize(
				'delverFunctionsOverflow',
				"{0} more not shown — use Go to Address",
				remaining,
			),
		},
		themeIcon: ThemeIcon.fromId(Codicon.ellipsis.id),
		collapsibleState: TreeItemCollapsibleState.None,
	};
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
