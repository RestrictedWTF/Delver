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
import { DELVER_PSEUDOCODE_EDITOR_ID, DelverPseudocodeInput } from '../../../services/delver/browser/delverPseudocodeInput.js';
import { DelverPseudocodeWidget } from './delverPseudocodeWidget.js';

/** Thin editor host for a torn-off pseudocode surface. */
export class DelverPseudocodeEditor extends EditorPane {

	static readonly ID = DELVER_PSEUDOCODE_EDITOR_ID;

	private widget!: DelverPseudocodeWidget;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(DelverPseudocodeEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.widget = this._register(this.instantiationService.createInstance(DelverPseudocodeWidget));
		this.widget.render(parent);
	}

	override async setInput(input: DelverPseudocodeInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options as never, context, token);
		await this.widget.setTarget(input.targetPath, input.functionRva, input.functionName, token);
	}

	override layout(dimension: Dimension): void {
		this.widget.layout(dimension);
	}

	protected override setEditorVisible(visible: boolean): void {
		this.widget.setVisible(visible);
	}

	override focus(): void {
		this.widget.focus();
	}

	override clearInput(): void {
		this.widget.clear();
		super.clearInput();
	}
}
