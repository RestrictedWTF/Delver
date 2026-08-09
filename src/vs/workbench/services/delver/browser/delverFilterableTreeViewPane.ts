/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Delayer } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TreeViewPane } from '../../../browser/parts/views/treeView.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { ITreeView, ITreeViewDataProvider, IViewDescriptorService } from '../../../common/views.js';
import { IAccessibleViewInformationService } from '../../accessibility/common/accessibleViewInformationService.js';
import './media/delverFilterableTreeViewPane.css';

export interface IDelverFilterableTreeDataProvider extends ITreeViewDataProvider {
	setFilter(query: string): void;
}

// TreeView wraps assigned data providers to manage parents, children, and empty
// state. Keep the original provider separately because that wrapper intentionally
// exposes only ITreeViewDataProvider and therefore cannot forward setFilter.
const filterProviders = new WeakMap<ITreeView, IDelverFilterableTreeDataProvider>();

export function registerDelverTreeFilterProvider(treeView: ITreeView, provider: IDelverFilterableTreeDataProvider): void {
	filterProviders.set(treeView, provider);
}

/** Tree view pane with a persistent, debounced text filter above the tree. */
export class DelverFilterableTreeViewPane extends TreeViewPane {
	private filterRow: HTMLElement | undefined;
	private readonly filterDelayer = this._register(new Delayer<void>(120));

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@INotificationService notificationService: INotificationService,
		@IHoverService hoverService: IHoverService,
		@IAccessibleViewInformationService accessibleViewService: IAccessibleViewInformationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, notificationService, hoverService, accessibleViewService);
	}

	protected override renderTreeView(container: HTMLElement): void {
		this.filterRow = dom.append(container, dom.$('.delver-tree-filter'));
		const input = dom.append(this.filterRow, dom.$('input.delver-tree-filter-input')) as HTMLInputElement;
		input.type = 'search';
		input.placeholder = localize('delverFilterView', "Filter");
		input.ariaLabel = localize('delverFilterViewAria', "Filter view contents");
		const treeContainer = dom.append(container, dom.$('.delver-filterable-tree'));
		super.renderTreeView(treeContainer);

		this._register(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			void this.filterDelayer.trigger(async () => {
				const provider = filterProviders.get(this.treeView);
				provider?.setFilter(input.value);
				await this.treeView.refresh();
				if (provider && input.value.trim()) {
					const roots = await this.treeView.dataProvider?.getChildren();
					if (roots) {
						await this.treeView.expand([...roots]);
					}
				}
			}).catch(onUnexpectedError);
		}));
	}

	protected override layoutTreeView(height: number, width: number): void {
		const filterHeight = this.filterRow?.offsetHeight || 34;
		super.layoutTreeView(Math.max(0, height - filterHeight), width);
	}
}
