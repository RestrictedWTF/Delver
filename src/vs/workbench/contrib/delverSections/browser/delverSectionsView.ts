/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ITreeItem, ITreeViewDataProvider, TreeItemCollapsibleState } from '../../../common/views.js';
import { IGetImageInfoResult, ISectionWire } from '../../../../platform/delver/common/protocol.generated.js';

export const DELVER_SECTIONS_VIEW_ID = 'delver.view.sections';

export interface IDelverSectionTreeItem extends ITreeItem {
	readonly section: ISectionWire;
}

/**
 * Builds tree items for the sections of the currently attached PE image.
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
		return this.info.sections.map((section, index) => ({
			handle: `delver.section.${index}`,
			label: section.name,
			description: `va ${section.virtual_address}, raw ${section.raw_offset}`,
			tooltip: localize(
				'delverSectionTooltip',
				'VA: 0x{0} ({1} bytes)\nRaw: 0x{2} ({3} bytes)',
				section.virtual_address,
				section.virtual_size,
				section.raw_offset,
				section.raw_size
			),
			collapsibleState: TreeItemCollapsibleState.None,
			section,
		}));
	}
}
