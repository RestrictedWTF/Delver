/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { basename } from '../../../../base/common/path.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import {
	Extensions as ViewContainerExtensions,
	IViewDescriptorService,
	IViewsRegistry,
} from '../../../common/views.js';
import { IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { DELVER_VIEW_CONTAINER } from '../../../services/delver/browser/delverViewContainer.js';
import { DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { DelverRecentTargetsStore } from '../../../services/delver/browser/delverWorkspaceState.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import './media/delverTargetLauncher.css';

export const DELVER_LAUNCHER_VIEW_ID = 'delver.view.launcher';

/** Lists open and recent targets, and opens one as a workspace editor. */
export class DelverTargetLauncherView extends ViewPane {

	private list!: HTMLElement;
	private readonly recents: DelverRecentTargetsStore;

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
		@IHoverService hoverService: IHoverService,
		@IAccessibleViewInformationService accessibleViewService: IAccessibleViewInformationService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewService);
		this.recents = new DelverRecentTargetsStore(storageService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('delver-target-launcher');
		// The button comes first. It is the one thing an analyst needs on an empty
		// workspace, and at the bottom of a long recents list it was below the
		// fold exactly when it mattered most.
		const open = dom.append(container, dom.$('button.delver-launcher-open')) as HTMLButtonElement;
		open.type = 'button';
		open.textContent = localize('delverLauncherOpen', "Open Target…");
		this._register(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand('delver.target.open');
		}));

		this.list = dom.append(container, dom.$('.delver-launcher-list'));

		this._register(this.editorService.onDidEditorsChange(() => this.refresh()));
		this.refresh();
	}

	private refresh(): void {
		dom.clearNode(this.list);

		const openPaths = new Set<string>();
		for (const editor of this.editorService.editors) {
			if (editor instanceof DelverWorkspaceInput) {
				openPaths.add(editor.targetPath);
			}
		}

		if (openPaths.size > 0) {
			this.appendSection(localize('delverLauncherOpenTargets', "Open Targets"), [...openPaths]);
		}

		// A target that is already open is not a "recent" one — showing it twice
		// makes the two lists look like they disagree about what is loaded.
		const recent = this.recents.list().filter(path => !openPaths.has(path));
		if (recent.length > 0) {
			this.appendSection(localize('delverLauncherRecent', "Recent"), recent);
		}

		if (openPaths.size === 0 && recent.length === 0) {
			const empty = dom.append(this.list, dom.$('.delver-launcher-empty'));
			empty.textContent = localize('delverLauncherEmpty', "No targets opened yet.");
		}
	}

	private appendSection(title: string, paths: readonly string[]): void {
		const heading = dom.append(this.list, dom.$('.delver-launcher-heading'));
		heading.textContent = title;
		for (const path of paths) {
			const row = dom.append(this.list, dom.$('button.delver-launcher-row')) as HTMLButtonElement;
			row.type = 'button';
			// The basename is what an analyst recognises; the full path is what
			// distinguishes two copies of the same sample, so it stays reachable
			// rather than being the label.
			row.textContent = basename(path);
			row.title = path;
			this._register(dom.addDisposableListener(row, dom.EventType.CLICK, () => {
				void this.editorService.openEditor(this.instantiationService.createInstance(DelverWorkspaceInput, path));
			}));
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.list.style.height = `${Math.max(0, height - 40)}px`;
	}
}

/** Registers the launcher view into the Delver container. */
export function registerDelverTargetLauncher(): void {
	Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
		id: DELVER_LAUNCHER_VIEW_ID,
		name: localize2('delverLauncher', "Targets"),
		ctorDescriptor: new SyncDescriptor(DelverTargetLauncherView),
		canToggleVisibility: false,
		canMoveView: false,
		order: 1,
	}], DELVER_VIEW_CONTAINER);
}
