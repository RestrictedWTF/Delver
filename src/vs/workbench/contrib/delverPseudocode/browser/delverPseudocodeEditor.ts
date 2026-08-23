/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IDelverDecompilerService, IDecompiledFunction, rangesForDecompilerLine } from '../../../services/delver/common/delverDecompilerService.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { DELVER_PSEUDOCODE_EDITOR_ID, DelverPseudocodeInput } from './delverPseudocodeInput.js';
import { focusForPseudocodeLine, pseudocodeLineForRva } from './delverPseudocodeModel.js';

const FOCUS_ORIGIN = 'delver.editor.pseudocode';

export class DelverPseudocodeEditor extends EditorPane {

	static readonly ID = DELVER_PSEUDOCODE_EDITOR_ID;

	private container!: HTMLElement;
	private message!: HTMLTextAreaElement;
	private actions!: HTMLElement;
	private retryButton!: Button;
	private restartButton!: Button;
	private provenance!: HTMLElement;
	private editorContainer!: HTMLElement;
	private editor!: CodeEditorWidget;
	private dimension: Dimension | undefined;
	private result: IDecompiledFunction | undefined;
	private applyingFocus = false;

	private readonly inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly model = this._register(new MutableDisposable<ITextModel>());
	private readonly recoveryOperation = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IDelverDecompilerService private readonly decompilerService: IDelverDecompilerService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
	) {
		super(DelverPseudocodeEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.delver-pseudocode'));
		this.message = dom.append(this.container, dom.$('textarea.delver-pseudocode-message')) as HTMLTextAreaElement;
		this.message.readOnly = true;
		this.message.spellcheck = false;
		this.message.setAttribute('aria-label', localize('delverPseudocodeMessage', "Pseudocode status and error details"));
		this.actions = dom.append(this.container, dom.$('.delver-pseudocode-actions'));
		this.retryButton = this._register(new Button(this.actions, { ...defaultButtonStyles, secondary: true }));
		this.retryButton.label = localize('delverPseudocodeRetry', "Retry");
		this._register(this.retryButton.onDidClick(() => void this.recover(false)));
		this.restartButton = this._register(new Button(this.actions, defaultButtonStyles));
		this.restartButton.label = localize('delverPseudocodeRestart', "Restart Decompiler");
		this._register(this.restartButton.onDidClick(() => void this.recover(true)));
		this.actions.style.display = 'none';
		this.provenance = dom.append(this.container, dom.$('.delver-pseudocode-provenance'));
		this.provenance.style.display = 'none';
		this.editorContainer = dom.append(this.container, dom.$('.delver-pseudocode-editor'));

		const options: IEditorConstructionOptions = {
			readOnly: true,
			wordWrap: 'off',
			lineNumbers: 'on',
			glyphMargin: false,
			folding: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			renderLineHighlight: 'line',
			fontFamily: 'var(--monaco-monospace-font)',
		};
		this.editor = this._register(this.instantiationService.createInstance(CodeEditorWidget, this.editorContainer, options, Object.create(null)));
	}

	override async setInput(
		input: DelverPseudocodeInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);
		this.releaseInput();

		this.showMessage(localize('delverPseudocodeLoading', "Loading pseudocode…"));
		try {
			const result = await this.requestPseudocode(input, token, false);
			if (token.isCancellationRequested || this.input !== input) {
				return;
			}
			this.showResult(result, input);
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error)) {
				const session = this.sessionService.activeSession;
				const diagnostic = session ? this.decompilerService.savedResultDiagnostic({ contentHash: session.contentHash, functionRva: input.functionRva }) : undefined;
				this.showMessage(diagnostic
					? localize('delverPseudocodeFailedWithSavedDiagnostic', "Could not load pseudocode: {0}\n\nSaved result diagnostic: {1}", toMessage(error), diagnostic)
					: localize('delverPseudocodeFailed', "Could not decompile function: {0}", toMessage(error)), true);
			}
		}
	}

	private async requestPseudocode(input: DelverPseudocodeInput, token: CancellationToken, refresh: boolean): Promise<IDecompiledFunction> {
		const activeSession = this.sessionService.activeSession;
		const session = activeSession?.targetPath === input.targetPath || activeSession?.projectPath === input.targetPath
			? activeSession
			: await this.sessionService.openTarget(input.targetPath);
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		const request = {
			sessionId: session.sessionId,
			targetPath: session.targetPath,
			contentHash: session.contentHash,
			functionRva: input.functionRva,
		};
		return refresh
			? this.decompilerService.redecompileFunction(request, token)
			: this.decompilerService.decompileFunction(request, token);
	}

	private async recover(restart: boolean): Promise<void> {
		const input = this.input;
		if (!(input instanceof DelverPseudocodeInput)) {
			return;
		}
		this.recoveryOperation.value?.cancel();
		const source = new CancellationTokenSource();
		this.recoveryOperation.value = source;
		this.showMessage(restart
			? localize('delverPseudocodeRestarting', "Restarting decompiler…")
			: localize('delverPseudocodeRetrying', "Retrying decompilation…"));
		try {
			if (restart) {
				const status = await this.decompilerService.restart();
				if (status.state !== 'ready') {
					throw new Error(status.diagnostic ? `${status.reason}\n${status.diagnostic}` : status.reason);
				}
			}
			const result = await this.requestPseudocode(input, source.token, true);
			if (!source.token.isCancellationRequested && this.input === input) {
				this.showResult(result, input);
			}
		} catch (error) {
			if (!source.token.isCancellationRequested && !isCancellationError(error) && this.input === input) {
				this.showMessage(localize('delverPseudocodeRecoveryFailed', "Could not recover the decompiler: {0}", toMessage(error)), true);
			}
		} finally {
			if (this.recoveryOperation.value === source) {
				this.recoveryOperation.clear();
			}
		}
	}

	private showResult(result: IDecompiledFunction, input: DelverPseudocodeInput): void {
		this.result = result;
		this.message.style.display = 'none';
		this.actions.style.display = 'none';
		this.editorContainer.style.display = '';
		if (result.provenance === 'saved') {
			this.provenance.textContent = localize('delverPseudocodeSavedProvenance', "Saved · {0} {1}", result.backendId, result.backendVersion ?? '');
		} else {
			const requestMs = result.timings
				? result.timings.targetOpenMs + result.timings.functionRecoveryMs + result.timings.decompilationMs + result.timings.serializationMs
				: undefined;
			this.provenance.textContent = requestMs === undefined
				? localize('delverPseudocodeLiveProvenance', "Live · {0} {1}", result.backendId, result.backendVersion ?? '')
				: localize('delverPseudocodeLiveTimedProvenance', "Live · {0} {1} · {2}", result.backendId, result.backendVersion ?? '', formatDuration(requestMs));
		}
		this.provenance.style.display = '';

		// The same function can be split into two editor groups. Give each pane its
		// own model so disposing one side cannot invalidate the other side's view.
		const modelResource = input.resource.with({ query: `group=${this.group.id}` });
		this.inputDisposables.clear();
		let textModel = this.model.value;
		if (textModel?.uri.toString() === modelResource.toString()) {
			textModel.setValue(result.text);
		} else {
			this.editor.setModel(null);
			this.model.clear();
			textModel = this.modelService.createModel(result.text, this.languageService.createById('c'), modelResource);
			this.model.value = textModel;
		}
		this.editor.setModel(textModel);

		const store = new DisposableStore();
		this.inputDisposables.value = store;
		store.add(this.editor.onDidChangeCursorSelection(event => {
			if (!this.applyingFocus) {
				this.publishFocus(event.selection.positionLineNumber);
			}
		}));
		store.add(this.focusService.onDidChangeFocus(event => {
			if (event.origin !== FOCUS_ORIGIN) {
				this.applyFocus();
			}
		}));
		this.applyFocus();
		if (this.dimension) {
			this.editor.layout(this.dimension);
		}
	}

	private publishFocus(line: number): void {
		const result = this.result;
		if (!result) {
			return;
		}
		const focus = focusForPseudocodeLine(result, line);
		if (!focus) {
			return;
		}
		this.focusService.setFocus({
			location: { space: 'Image', address: focus.address },
			selection: focus.selection,
			selections: rangesForDecompilerLine(result, line).map(range => ({ start: range.startRva, end: range.endRva })),
		}, FOCUS_ORIGIN, FocusReason.User);
	}

	private applyFocus(): void {
		const result = this.result;
		const location = this.focusService.focus.location;
		if (!result || !location || location.space !== 'Image') {
			return;
		}
		const line = pseudocodeLineForRva(result, location.address);
		if (line === undefined) {
			return;
		}
		this.applyingFocus = true;
		try {
			this.editor.setPosition({ lineNumber: line, column: 1 });
			this.editor.revealLineInCenter(line);
		} finally {
			this.applyingFocus = false;
		}
	}

	private showMessage(message: string, recoverable = false): void {
		this.result = undefined;
		this.provenance.style.display = 'none';
		this.message.value = message;
		this.message.style.display = '';
		this.actions.style.display = recoverable ? '' : 'none';
		this.editorContainer.style.display = 'none';
	}

	private releaseInput(): void {
		this.recoveryOperation.value?.cancel();
		this.recoveryOperation.clear();
		this.inputDisposables.clear();
		this.result = undefined;
		if (this.editor) {
			this.editor.setModel(null);
		}
		this.model.clear();
	}

	override focus(): void {
		if (this.message.style.display !== 'none') {
			this.message.focus();
		} else {
			this.editor.focus();
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.editor.layout(dimension);
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.dimension) {
			this.editor.layout(this.dimension);
		}
	}

	override clearInput(): void {
		this.releaseInput();
		super.clearInput();
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
