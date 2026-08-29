/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { DELVER_LISTING_EDITOR_ID, DelverListingInput } from '../../../services/delver/browser/delverListingInput.js';
import { DelverListingWidget } from './delverListingWidget.js';

/**
 * Editor host for a torn-off listing.
 *
 * All rendering lives in `DelverListingWidget`, which a workspace zone hosts
 * directly. This class exists so a listing can *also* be a real editor tab,
 * which is what gives the comparison workflow splits, tabs, and layout
 * persistence (`Docs/design/workspace.md` §3).
 */
export class DelverListingEditor extends EditorPane {

	static readonly ID = DELVER_LISTING_EDITOR_ID;

	private widget!: DelverListingWidget;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(DelverListingEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.widget = this._register(this.instantiationService.createInstance(DelverListingWidget));
		this.widget.render(parent);
	}

	override async setInput(
		input: DelverListingInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);
		await this.widget.setTarget(input.targetPath, token);
	}

	override layout(dimension: Dimension): void {
		this.widget.layout(dimension);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.widget.setVisible(visible);
	}

	override clearInput(): void {
		this.widget.clear();
		super.clearInput();
	}

	override focus(): void {
		this.widget.focus();
	}
}
