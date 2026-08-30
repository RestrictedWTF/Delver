/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { DisagreementKind, IAdjudicatedRow } from '../../../../platform/delver/common/delverFunctionAdjudication.js';
import { placeholderFunctionName } from '../../../../platform/delver/common/naming.js';
import { FunctionSourceWire } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { IFunctionHandshake } from '../../../services/delver/common/delverFunctionHandshake.js';

export const DELVER_HANDSHAKE_VIEW_ID = 'delver.view.handshake';
export const DELVER_HANDSHAKE_OPEN_COMMAND = 'delver.handshake.goTo';
export const DELVER_HANDSHAKE_HANDLE_PREFIX = 'delver.handshake.row.';

/** Maximum rows materialized by one expanded group. */
export const HANDSHAKE_PAGE_SIZE = 1_000;

const GROUP_PREFIX = 'delver.handshake.group.';
const PAGE_PREFIX = 'delver.handshake.page.';

/**
 * The order groups appear in, most worth an analyst's attention first.
 *
 * Coverage gaps lead because they are the only kinds where one side found code
 * the other has nothing for at all. A boundary dispute means both sides agree
 * the bytes are code, and an extent dispute usually comes down to trailing
 * padding, so neither is where an investigation starts.
 */
const GROUP_ORDER: readonly DisagreementKind[] = [
	DisagreementKind.BackendCoverageGap,
	DisagreementKind.DelverCoverageGap,
	DisagreementKind.BoundaryDispute,
	DisagreementKind.ExtentDispute,
];

/**
 * The cross-backend function handshake, as a tree (ADR 0017).
 *
 * Shows disagreement and counts agreement. Agreeing rows are the overwhelming
 * majority on a healthy image and there is nothing to do with them one at a
 * time, but their number is what makes a disagreement count mean anything, so it
 * is stated rather than dropped.
 */
export class DelverHandshakeTreeDataProvider implements ITreeViewDataProvider {
	private result: IFunctionHandshake | undefined;
	private byKind = new Map<DisagreementKind, readonly IAdjudicatedRow[]>();
	private backendNames = new Map<string, string>();

	setResult(result: IFunctionHandshake | undefined): void {
		this.result = result;
		this.byKind = new Map();
		this.backendNames = new Map();
		if (!result) {
			return;
		}
		for (const row of result.adjudication.rows) {
			if (row.kind === DisagreementKind.Agreement) {
				continue;
			}
			const existing = this.byKind.get(row.kind);
			this.byKind.set(row.kind, existing ? [...existing, row] : [row]);
		}
		for (const row of result.reconciliation.rows) {
			if (row.backend?.name) {
				this.backendNames.set(row.rva.toString(16), row.backend.name);
			}
		}
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		const result = this.result;
		if (!result) {
			return [];
		}
		if (!element) {
			return this.rootItems(result);
		}
		const kind = kindFromGroupHandle(element.handle);
		if (kind) {
			return this.groupChildren(kind);
		}
		const page = parsePageHandle(element.handle);
		if (!page) {
			return [];
		}
		const rows = this.byKind.get(page.kind) ?? [];
		return rows
			.slice(page.start, page.start + HANDSHAKE_PAGE_SIZE)
			.map(row => this.rowItem(row));
	}

	private rootItems(result: IFunctionHandshake): readonly ITreeItem[] {
		const items: ITreeItem[] = [{
			handle: 'delver.handshake.summary',
			label: {
				label: localize(
					'delverHandshakeAgreed',
					"{0} of {1} functions agree",
					result.summary.agree,
					result.summary.delverFunctions,
				),
			},
			description: localize(
				'delverHandshakeBackend',
				"vs {0} ({1} functions)",
				result.summary.backendId,
				result.summary.backendFunctions,
			),
			themeIcon: ThemeIcon.fromId(Codicon.check.id),
			collapsibleState: TreeItemCollapsibleState.None,
		}];

		for (const kind of GROUP_ORDER) {
			const rows = this.byKind.get(kind) ?? [];
			if (rows.length === 0) {
				continue;
			}
			const concentration = result.summary.concentrations.find(([entry]) => entry === kind);
			items.push({
				handle: `${GROUP_PREFIX}${kind}`,
				label: { label: groupLabel(kind) },
				// A concentration is a lead, so it is named where the count is
				// rather than buried in a row: "these are nearly all one source"
				// is the part that points at a cause.
				description: concentration
					? localize('delverHandshakeConcentrated', "{0} — mostly {1}", rows.length, describeSource(concentration[1] as FunctionSourceWire))
					: String(rows.length),
				themeIcon: ThemeIcon.fromId(groupIcon(kind)),
				collapsibleState: TreeItemCollapsibleState.Collapsed,
			});
		}
		return items;
	}

	private groupChildren(kind: DisagreementKind): readonly ITreeItem[] {
		const rows = this.byKind.get(kind) ?? [];
		if (rows.length <= HANDSHAKE_PAGE_SIZE) {
			return rows.map(row => this.rowItem(row));
		}
		const pages: ITreeItem[] = [];
		for (let start = 0; start < rows.length; start += HANDSHAKE_PAGE_SIZE) {
			const end = Math.min(rows.length, start + HANDSHAKE_PAGE_SIZE);
			pages.push({
				handle: `${PAGE_PREFIX}${kind}.${start}`,
				label: { label: localize('delverHandshakePage', "Rows {0}-{1}", start + 1, end) },
				description: `0x${rows[start].rva.toString(16)}-0x${rows[end - 1].rva.toString(16)}`,
				themeIcon: ThemeIcon.fromId(Codicon.listTree.id),
				collapsibleState: TreeItemCollapsibleState.Collapsed,
			});
		}
		return pages;
	}

	private rowItem(row: IAdjudicatedRow): ITreeItem {
		const backendName = this.backendNames.get(row.rva.toString(16));
		return {
			handle: `${DELVER_HANDSHAKE_HANDLE_PREFIX}0x${row.rva.toString(16)}`,
			contextValue: 'delver-handshake-row',
			label: { label: placeholderFunctionName(row.rva) },
			// Says what each side claims rather than who is right. Neither set is
			// ground truth, and a row that read as a verdict would be one.
			description: row.source !== undefined
				? localize('delverHandshakeRowDelver', "Delver: {0}", describeSource(row.source))
				: localize('delverHandshakeRowBackend', "backend only: {0}", backendName ?? '—'),
			themeIcon: ThemeIcon.fromId(Codicon.symbolFunction.id),
			collapsibleState: TreeItemCollapsibleState.None,
			command: {
				id: DELVER_HANDSHAKE_OPEN_COMMAND,
				title: localize('delverHandshakeGoTo', "Go to Address"),
				arguments: [`0x${row.rva.toString(16)}`],
			},
		};
	}
}

/** The address a row handle names, or `undefined` for any other handle. */
export function handshakeRvaFromHandle(handle: string): bigint | undefined {
	if (!handle.startsWith(DELVER_HANDSHAKE_HANDLE_PREFIX)) {
		return undefined;
	}
	try {
		return BigInt(handle.slice(DELVER_HANDSHAKE_HANDLE_PREFIX.length));
	} catch {
		return undefined;
	}
}

function groupLabel(kind: DisagreementKind): string {
	switch (kind) {
		case DisagreementKind.BackendCoverageGap:
			return localize('delverHandshakeBackendGap', "Only Delver found these");
		case DisagreementKind.DelverCoverageGap:
			return localize('delverHandshakeDelverGap', "Only the backend found these");
		case DisagreementKind.BoundaryDispute:
			return localize('delverHandshakeBoundary', "Split differently");
		case DisagreementKind.ExtentDispute:
			return localize('delverHandshakeExtent', "Bounded differently");
		case DisagreementKind.Agreement:
			return localize('delverHandshakeAgreement', "Agree");
	}
}

function groupIcon(kind: DisagreementKind): string {
	switch (kind) {
		case DisagreementKind.BackendCoverageGap:
		case DisagreementKind.DelverCoverageGap:
			return Codicon.warning.id;
		default:
			return Codicon.gitCompare.id;
	}
}

function describeSource(source: FunctionSourceWire): string {
	switch (source) {
		case FunctionSourceWire.ExceptionDirectory: return localize('delverHsException', "exception directory");
		case FunctionSourceWire.EntryPoint: return localize('delverHsEntry', "entry point");
		case FunctionSourceWire.Export: return localize('delverHsExport', "export");
		case FunctionSourceWire.TlsCallback: return localize('delverHsTls', "TLS callback");
		case FunctionSourceWire.CallTarget: return localize('delverHsCall', "called");
		case FunctionSourceWire.LinearSweep: return localize('delverHsSweep', "guess");
		case FunctionSourceWire.Authored: return localize('delverHsAuthored', "authored");
		default: return '';
	}
}

function kindFromGroupHandle(handle: string): DisagreementKind | undefined {
	if (!handle.startsWith(GROUP_PREFIX)) {
		return undefined;
	}
	const value = handle.slice(GROUP_PREFIX.length);
	return GROUP_ORDER.find(kind => kind === value);
}

function parsePageHandle(handle: string): { kind: DisagreementKind; start: number } | undefined {
	if (!handle.startsWith(PAGE_PREFIX)) {
		return undefined;
	}
	const rest = handle.slice(PAGE_PREFIX.length);
	const separator = rest.lastIndexOf('.');
	if (separator < 0) {
		return undefined;
	}
	const kind = GROUP_ORDER.find(candidate => candidate === rest.slice(0, separator));
	const start = Number(rest.slice(separator + 1));
	return kind !== undefined && Number.isInteger(start) && start >= 0 ? { kind, start } : undefined;
}
