/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IDelverSurface } from '../../../services/delver/browser/delverSurface.js';
import { IDelverDecompilerService, IDecompiledFunction, rangesForDecompilerLine } from '../../../services/delver/common/delverDecompilerService.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { DelverPseudocodeInput } from './delverPseudocodeInput.js';
import { isPseudocodeSyncEnabled } from './delverPseudocodeSync.js';
import { focusForPseudocodeLine, pseudocodeLineForRva } from './delverPseudocodeModel.js';

const FOCUS_ORIGIN = 'delver.editor.pseudocode';

/** Pseudocode widget shared by the workspace and the tear-off editor host. */
export class DelverPseudocodeWidget extends Disposable implements IDelverSurface {

	private readonly modelKey = generateUuid();
	private message!: HTMLTextAreaElement;
	private actions!: HTMLElement;
	/**
	 * Decompiler provenance lives in the status bar, not over the code.
	 *
	 * `principles.md` §1 requires it to stay visible — an analyst must always be
	 * able to ask "how much should I trust this?" — but a floating badge sat on
	 * top of the first lines of the function, which is the part most often read.
	 */
	private readonly provenanceEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private editorContainer!: HTMLElement;
	private editor!: CodeEditorWidget;
	private dimension: Dimension | undefined;
	private result: IDecompiledFunction | undefined;
	private input: DelverPseudocodeInput | undefined;
	private applyingFocus = false;
	private visible = false;

	private readonly inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly model = this._register(new MutableDisposable<ITextModel>());
	private readonly recoveryOperation = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IDelverDecompilerService private readonly decompilerService: IDelverDecompilerService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
	}

	render(parent: HTMLElement): void {
		const container = dom.append(parent, dom.$('.delver-pseudocode'));
		this.message = dom.append(container, dom.$('textarea.delver-pseudocode-message')) as HTMLTextAreaElement;
		this.message.readOnly = true;
		this.message.spellcheck = false;
		this.message.setAttribute('aria-label', localize('delverPseudocodeMessage', "Pseudocode status and error details"));
		this.actions = dom.append(container, dom.$('.delver-pseudocode-actions'));
		const retryButton = this._register(new Button(this.actions, { ...defaultButtonStyles, secondary: true }));
		retryButton.label = localize('delverPseudocodeRetry', "Retry");
		this._register(retryButton.onDidClick(() => void this.recover(false)));
		const restartButton = this._register(new Button(this.actions, defaultButtonStyles));
		restartButton.label = localize('delverPseudocodeRestart', "Restart Decompiler");
		this._register(restartButton.onDidClick(() => void this.recover(true)));
		this.actions.style.display = 'none';
		this.editorContainer = dom.append(container, dom.$('.delver-pseudocode-editor'));

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

	async setTarget(targetPath: string, functionRva: bigint | undefined, functionName: string | undefined, token: CancellationToken): Promise<void> {
		this.releaseInput();
		if (functionRva === undefined) {
			this.showMessage(localize('delverPseudocodeNoFunction', "Select an address inside a detected function to show pseudocode."));
			return;
		}
		const input = new DelverPseudocodeInput(targetPath, functionRva, functionName);
		this.input = input;
		this.showMessage(localize('delverPseudocodeLoading', "Loading pseudocode…"));
		try {
			const result = await this.requestPseudocode(input, token, false);
			if (token.isCancellationRequested || this.input !== input) {
				return;
			}
			this.showResult(result, input);
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error) && this.input === input) {
				const session = this.sessionService.activeSession;
				const diagnostic = session ? this.decompilerService.savedResultDiagnostic({ contentHash: session.contentHash, functionRva }) : undefined;
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
		if (!input) {
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
		this.showProvenance(result);

		const modelResource = input.resource.with({ query: `surface=${this.modelKey}` });
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
			if (this.visible && !this.applyingFocus) {
				this.publishFocus(event.selection.positionLineNumber);
			}
		}));
		store.add(this.focusService.onDidChangeFocus(event => {
			if (this.visible && event.origin !== FOCUS_ORIGIN) {
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
		// Sync off means the listing stops following this cursor. Publishing
		// anyway and having the listing ignore it would be wrong: the focus bus
		// is what every other surface reads too, so this must not speak at all.
		if (!result || !isPseudocodeSyncEnabled()) {
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

	/** Publishes decompiler provenance to the status bar. */
	private showProvenance(result: IDecompiledFunction): void {
		let text: string;
		if (result.provenance === 'saved') {
			text = localize('delverPseudocodeSavedProvenance', "Saved · {0} {1}", result.backendId, result.backendVersion ?? '');
		} else {
			const requestMs = result.timings
				? result.timings.targetOpenMs + result.timings.functionRecoveryMs + result.timings.decompilationMs + result.timings.serializationMs
				: undefined;
			text = requestMs === undefined
				? localize('delverPseudocodeLiveProvenance', "Live · {0} {1}", result.backendId, result.backendVersion ?? '')
				: localize('delverPseudocodeLiveTimedProvenance', "Live · {0} {1} · {2}", result.backendId, result.backendVersion ?? '', formatDuration(requestMs));
		}
		const name = localize('delverPseudocodeProvenanceName', "Delver Decompiler");
		if (this.provenanceEntry.value) {
			this.provenanceEntry.value.update({ name, text, ariaLabel: text });
		} else {
			this.provenanceEntry.value = this.statusbarService.addEntry(
				{ name, text, ariaLabel: text },
				'delver.pseudocode.provenance',
				StatusbarAlignment.RIGHT,
				100,
			);
		}
	}

	private showMessage(message: string, recoverable = false): void {
		this.result = undefined;
		this.provenanceEntry.clear();
		this.message.value = message;
		this.message.style.display = '';
		this.actions.style.display = recoverable ? '' : 'none';
		this.editorContainer.style.display = 'none';
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.editor.layout(dimension);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible && this.dimension) {
			this.editor.layout(this.dimension);
			this.applyFocus();
		}
		if (!visible) {
			// The status bar is global. A hidden pseudocode pane must not keep
			// claiming it, or the analyst reads provenance for something they
			// are no longer looking at — the exact confusion §1 warns about.
			this.provenanceEntry.clear();
		} else if (this.result) {
			this.showProvenance(this.result);
		}
	}

	focus(): void {
		if (this.message.style.display !== 'none') {
			this.message.focus();
		} else {
			this.editor.focus();
		}
	}

	clear(): void {
		this.releaseInput();
	}

	private releaseInput(): void {
		this.recoveryOperation.value?.cancel();
		this.recoveryOperation.clear();
		this.inputDisposables.clear();
		this.input?.dispose();
		this.input = undefined;
		this.result = undefined;
		if (this.editor) {
			this.editor.setModel(null);
		}
		this.model.clear();
	}

	override dispose(): void {
		this.releaseInput();
		super.dispose();
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
