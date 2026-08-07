/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IXrefWire, XrefKindWire } from '../../../../platform/delver/common/protocol.generated.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';

export const DELVER_XREFS_VIEW_ID = 'delver.view.xrefs';

/** Command invoked when a reference is clicked. */
export const DELVER_XREFS_OPEN_COMMAND = 'delver.xrefs.goTo';

/**
 * The two directions a reference can be read in.
 *
 * Both matter and they answer different questions: `to` is "who reaches this",
 * which is how you work outward from something interesting; `from` is "what does
 * this reach", which is how you read a function's shape without stepping
 * through it.
 */
export interface IXrefsContent {
	readonly address: string;
	readonly to: readonly IXrefWire[];
	readonly from: readonly IXrefWire[];
}

export class DelverXrefsTreeDataProvider implements ITreeViewDataProvider {
	private content: IXrefsContent | undefined;

	setContent(content: IXrefsContent | undefined): void {
		this.content = content;
	}

	async getChildren(element?: ITreeItem): Promise<readonly ITreeItem[] | undefined> {
		const content = this.content;
		if (!content) {
			return [];
		}

		if (!element) {
			return [
				group('to', localize('delverXrefsTo', "References to {0}", content.address), content.to.length),
				group('from', localize('delverXrefsFrom', "References from {0}", content.address), content.from.length),
			];
		}

		const xrefs = element.handle === 'delver.xrefs.to' ? content.to : content.from;
		const showTarget = element.handle === 'delver.xrefs.from';
		return xrefs.map((xref, index) => item(xref, index, showTarget));
	}
}

function group(id: string, label: string, count: number): ITreeItem {
	return {
		handle: `delver.xrefs.${id}`,
		label: { label },
		description: String(count),
		// Expanded by default: a references panel that has to be unfolded before
		// it says anything is a panel nobody reads.
		collapsibleState: count > 0
			? TreeItemCollapsibleState.Expanded
			: TreeItemCollapsibleState.None,
	};
}

function item(xref: IXrefWire, index: number, showTarget: boolean): ITreeItem {
	// Addresses arrive as "0x..." strings (ADR 0001) and are shown as they
	// arrived. The interesting end differs by direction: for a reference *to*
	// the focus, it is where it came from.
	const address = showTarget ? xref.to : xref.from;
	return {
		handle: `delver.xref.${showTarget ? 'from' : 'to'}.${index}`,
		label: { label: address },
		description: describe(xref.kind),
		collapsibleState: TreeItemCollapsibleState.None,
		command: {
			id: DELVER_XREFS_OPEN_COMMAND,
			title: localize('delverXrefGoTo', "Go to Reference"),
			arguments: [address],
		},
	};
}

function describe(kind: XrefKindWire): string {
	switch (kind) {
		case XrefKindWire.Call: return localize('delverXrefCall', "call");
		case XrefKindWire.Jump: return localize('delverXrefJump', "jump");
		case XrefKindWire.ConditionalJump: return localize('delverXrefConditionalJump', "conditional");
		case XrefKindWire.Data: return localize('delverXrefData', "data");
		default: return '';
	}
}
