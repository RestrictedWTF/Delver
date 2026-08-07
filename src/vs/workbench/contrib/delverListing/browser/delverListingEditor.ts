/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import {
	IAnalysisSessionHandle,
	IDelverAnalysisService,
} from '../../../../platform/delver/common/delverAnalysisService.js';
import { FlowKindWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import {
	IDelverSession,
	IDelverSessionService,
} from '../../../services/delver/common/delverSessionService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { functionDisplayName } from '../../../../platform/delver/common/naming.js';
import {
	DELVER_LISTING_PINNED,
	DELVER_NAVIGATION_ORIGIN,
	shouldFollowWhilePinned,
} from './delverListingContext.js';
import { DELVER_LISTING_EDITOR_ID, DelverListingInput } from './delverListingInput.js';
import { DelverListingModel, IListingRow } from './delverListingModel.js';

/** Identifies this view on the focus bus, so it can ignore its own echo. */
const FOCUS_ORIGIN = 'delver.editor.listing';

const ROW_HEIGHT = 22;

export class DelverListingEditor extends EditorPane {

	static readonly ID = DELVER_LISTING_EDITOR_ID;

	private container!: HTMLElement;
	private message!: HTMLElement;
	private tableContainer!: HTMLElement;
	private table: WorkbenchTable<IListingRow> | undefined;

	private readonly sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private session: IDelverSession | undefined;
	private publishedSession: IDelverSession | undefined;
	private model: DelverListingModel | undefined;

	/** Set while applying a focus change, so it is not echoed straight back. */
	private applyingFocus = false;

	private _pinned = false;
	private readonly pinnedContext: IContextKey<boolean>;

	/**
	 * Function entry addresses, in the `"0x..."` form rows carry.
	 *
	 * Held as the wire strings so a row lookup is a string hash rather than a
	 * `BigInt` parse per rendered row.
	 */
	private functionStarts = new Set<string>();

	/** Absolute ordinal of the row at the top of the viewport. */
	private topRow = 0;

	/** Last size the workbench gave this pane. */
	private dimension: Dimension | undefined;

	/** Re-splices the whole buffer, which is what forces heights to be recomputed. */
	private respliceBuffer(): void {
		const table = this.table;
		const model = this.model;
		if (!table || !model) {
			return;
		}
		const top = this.topRow;
		table.splice(0, table.length, model.rows);
		const index = model.indexOf(top);
		if (index !== -1) {
			table.reveal(index, 0);
		}
	}

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(DelverListingEditor.ID, group, telemetryService, themeService, storageService);
		this.pinnedContext = DELVER_LISTING_PINNED.bindTo(contextKeyService);
	}

	get pinned(): boolean {
		return this._pinned;
	}

	/**
	 * Stops or resumes following the rest of the workbench.
	 *
	 * Pin is **per-view state, not bus state**: pinning one listing must not
	 * change where anything else thinks it is looking.
	 */
	togglePin(): void {
		this._pinned = !this._pinned;
		this.pinnedContext.set(this._pinned);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.delver-listing'));
		this.message = dom.append(this.container, dom.$('.delver-listing-message'));
		this.tableContainer = dom.append(this.container, dom.$('.delver-listing-table'));
		this.message.textContent = localize('delverListingAnalyzing', "Analyzing…");
	}

	override async setInput(
		input: DelverListingInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);

		this.releaseSession();
		this.message.textContent = localize('delverListingAnalyzing', "Analyzing…");
		this.message.style.display = '';

		let handle: IDelverSession;
		try {
			// The session service owns this. Opening it here would tie the
			// analysis to this editor's lifetime, and switching to another tab
			// would tear it down underneath every other view.
			handle = await this.sessionService.openTarget(input.targetPath);
		} catch (error) {
			this.message.textContent = localize(
				'delverListingFailed',
				"Could not analyze {0}: {1}",
				input.targetPath,
				toMessage(error),
			);
			return;
		}

		// The editor may have been closed or retargeted while analysis ran. The
		// session is not disposed here — it belongs to the target, and something
		// else may already be using it.
		if (token.isCancellationRequested) {
			return;
		}

		this.session = handle;
		this.publishedSession = handle;
		this.message.style.display = 'none';
		this.createTable(handle);

		// Loaded after the table so the listing is usable immediately; a large
		// module has ~178k entries and the rows only gain their separators once
		// this lands.
		try {
			const { functions } = await this.analysisService.functions(handle.sessionId);
			if (this.session !== handle) {
				return;
			}
			this.functionStarts = new Set(functions.map(f => f.rva));
			// A splice, not a rerender: row heights change once starts are known,
			// and heights are only recomputed when elements are spliced in.
			this.respliceBuffer();
		} catch (error) {
			onUnexpectedError(error);
		}
	}

	private createTable(handle: IAnalysisSessionHandle): void {
		const store = new DisposableStore();
		this.sessionDisposables.value = store;

		// Disposing a list widget does not detach its DOM. Without this, every
		// re-entry into the editor leaves a dead table behind and they stack up,
		// pushing the live one out of view — which reads as a blank page.
		dom.clearNode(this.tableContainer);

		const model = new DelverListingModel(
			{
				listingWindow: async (startRow, count) =>
					(await this.analysisService.listingWindow(handle.sessionId, startRow, count)).rows,
			},
			handle.image.instruction_count,
		);
		store.add(model);
		this.model = model;

		// Height is per element, so a function's first instruction gets two lines:
		// its name on one, the instruction on the next. That is a real header
		// line sharing the row's address and ordinal, rather than an extra row
		// that would break the listing's row-to-address identity.
		const heightFor = (row: IListingRow) => this.isFunctionStart(row) ? ROW_HEIGHT * 2 : ROW_HEIGHT;
		const delegate = new class implements ITableVirtualDelegate<IListingRow> {
			readonly headerRowHeight = 0;
			getHeight(row: IListingRow): number {
				return heightFor(row);
			}
		}();

		const table = store.add(this.instantiationService.createInstance(
			WorkbenchTable,
			'DelverListing',
			this.tableContainer,
			delegate,
			[
				{
					label: localize('delverListingAddressColumn', "Address"),
					tooltip: '',
					weight: 0,
					minimumWidth: 140,
					maximumWidth: 140,
					templateId: AddressRenderer.TEMPLATE_ID,
					project(row: IListingRow): IListingRow { return row; },
				},
				{
					label: localize('delverListingInstructionColumn', "Instruction"),
					tooltip: '',
					weight: 1,
					templateId: InstructionRenderer.TEMPLATE_ID,
					project(row: IListingRow): IListingRow { return row; },
				},
			],
			[
				new AddressRenderer(row => this.isFunctionStart(row)),
				new InstructionRenderer(
					target => this.followTarget(target),
					rva => this.functionLabelFor(rva),
				),
			],
			{
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				overrideStyles: { listBackground: editorBackground },
			},
		)) as WorkbenchTable<IListingRow>;
		this.table = table;

		table.splice(0, table.length, model.rows);
		if (this.dimension) {
			table.layout(this.dimension.height, this.dimension.width);
		}

		store.add(model.onDidChangeRows(range => {
			// The table copied these elements when they were spliced in, so
			// updating the model's array is invisible to it and `rerender()`
			// would just redraw the stale placeholders. Replacing the range with
			// the same number of rows leaves total height — and so the scroll
			// position — untouched.
			table.splice(range.start, range.count, model.rows.slice(range.start, range.start + range.count));
		}));

		store.add(model.onDidMoveBuffer(() => {
			// Recentring replaces the buffer, so the view has to be put back where
			// it was. Revealing the row that was on top is exact and does not
			// assume a uniform row height — which stopped being true the moment
			// function headers became two lines tall.
			const top = this.topRow;
			table.splice(0, table.length, model.rows);
			const index = model.indexOf(top);
			if (index !== -1) {
				table.reveal(index, 0);
			}
			this.updateVisibleRange();
		}));

		// Renaming re-labels the listing immediately. Only visible rows repaint —
		// the buffer's contents are unchanged, just their labels.
		store.add(this.interpretationService.onDidChange(() => table.rerender()));

		store.add(table.onDidScroll(() => this.updateVisibleRange()));
		store.add(table.onDidChangeSelection(e => this.publishFocus(e.elements[0])));
		store.add(this.focusService.onDidChangeFocus(e => {
			if (e.origin !== FOCUS_ORIGIN && this.shouldFollow(e.reason)) {
				this.applyFocus();
			}
		}));

		this.updateVisibleRange();
	}

	private updateVisibleRange(): void {
		const table = this.table;
		const model = this.model;
		if (!table || !model) {
			return;
		}
		// Approximate: function headers are taller, so this over-estimates how
		// many rows are on screen. Over-estimating only prefetches a little wide,
		// which is the harmless direction to be wrong in.
		const first = model.bufferStart + Math.floor(table.scrollTop / ROW_HEIGHT);
		const visibleRows = Math.max(1, Math.ceil((this.dimension?.height ?? 0) / ROW_HEIGHT));
		this.topRow = first;
		model.setVisibleRange(first, first + visibleRows);
	}

	/**
	 * Label for a row that begins a function, or `undefined` for every other row.
	 *
	 * Function starts are the landmarks in a listing — without them it is an
	 * undifferentiated wall of instructions and there is no way to tell a
	 * function's first line from its middle.
	 */
	private isFunctionStart(row: IListingRow): boolean {
		return row.data !== undefined && this.functionStarts.has(row.data.rva);
	}

	private functionLabelFor(rva: string): string | undefined {
		if (!this.functionStarts.has(rva)) {
			return undefined;
		}
		const contentHash = this.publishedSession?.contentHash;
		const address = BigInt(rva);
		const authored = contentHash === undefined
			? undefined
			: this.interpretationService.nameAt({ kind: 'image', contentHash, rva: address });
		return functionDisplayName(address, authored);
	}

	private shouldFollow(reason: FocusReason): boolean {
		return !this._pinned || shouldFollowWhilePinned(reason);
	}

	/**
	 * Navigates to the branch target of the focused row, if it has one.
	 *
	 * Uses the navigation origin rather than this editor's own, so the jump
	 * lands in the focus history as a navigation and `Escape` returns from it.
	 */
	followSelection(): void {
		const table = this.table;
		if (!table) {
			return;
		}
		const focused = table.getFocusedElements()[0] ?? table.getSelectedElements()[0];
		this.followTarget(focused?.data?.branch_target);
	}

	private followTarget(target: string | undefined): void {
		if (target === undefined) {
			return;
		}
		this.focusService.setFocus(
			{ location: { space: 'Image', address: BigInt(target) } },
			DELVER_NAVIGATION_ORIGIN,
			FocusReason.User,
		);
	}

	/** Broadcasts the selected row's address to the rest of the workbench. */
	private publishFocus(row: IListingRow | undefined): void {
		if (this.applyingFocus || !row?.data) {
			return;
		}
		this.focusService.setFocus(
			{ location: { space: 'Image', address: BigInt(row.data.rva) } },
			FOCUS_ORIGIN,
			FocusReason.User,
		);
	}

	/** Scrolls to whatever the rest of the workbench is looking at. */
	private async applyFocus(): Promise<void> {
		const location = this.focusService.focus.location;
		const session = this.session;
		const model = this.model;
		const table = this.table;
		if (!location || !session || !model || !table) {
			return;
		}

		const rva = `0x${location.address.toString(16).toUpperCase()}`;
		const row = await this.analysisService.rowForAddress(session.sessionId, rva, true);
		if (row === undefined || this.model !== model) {
			return;
		}

		if (model.indexOf(row) === -1) {
			model.anchorAt(row);
		}
		const index = model.indexOf(row);
		if (index === -1) {
			return;
		}

		this.applyingFocus = true;
		try {
			table.reveal(index, 0.5);
			table.setFocus([index]);
			table.setSelection([index]);
		} finally {
			this.applyingFocus = false;
		}
		this.updateVisibleRange();
	}

	/**
	 * Sizes the table from the dimension the workbench supplies.
	 *
	 * Never from `clientHeight`: a hidden pane measures zero, so laying out from
	 * the DOM leaves the table sized to nothing the moment another tab takes the
	 * group — and it stays that way when this one comes back.
	 */
	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.table?.layout(dimension.height, dimension.width);
		this.updateVisibleRange();
	}

	/**
	 * Re-lays out when this pane comes back into view.
	 *
	 * A pane is reused across tab switches, and it is laid out while hidden —
	 * where a list widget measures zero and renders nothing. Sizing it again on
	 * the way back in is what makes a returned-to tab show its rows, and it is
	 * cheap enough to do unconditionally.
	 */
	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible && this.table && this.dimension) {
			this.table.layout(this.dimension.height, this.dimension.width);
			this.table.rerender();
		}
	}

	override clearInput(): void {
		this.releaseSession();
		super.clearInput();
	}

	override dispose(): void {
		this.releaseSession();
		super.dispose();
	}

	/**
	 * Drops this editor's view of the session without ending it.
	 *
	 * The session belongs to the target and outlives any one editor — closing
	 * this tab, or having it replaced by the strings tab, must not stop the rest
	 * of the workbench from knowing what is open.
	 */
	private releaseSession(): void {
		this.sessionDisposables.clear();
		this.table = undefined;
		this.model = undefined;
		this.publishedSession = undefined;
		this.session = undefined;
		this.functionStarts = new Set();
	}
}

interface ICellTemplate {
	readonly element: HTMLElement;
}

class AddressRenderer implements ITableRenderer<IListingRow, ICellTemplate> {
	static readonly TEMPLATE_ID = 'delver.listing.address';
	readonly templateId = AddressRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): ICellTemplate {
		return { element: dom.append(container, dom.$('.delver-listing-address')) };
	}

	constructor(private readonly isFunctionStart: (row: IListingRow) => boolean) { }

	renderElement(row: IListingRow, _index: number, template: ICellTemplate): void {
		// Addresses arrive as "0x..." strings (ADR 0001) and are displayed as
		// they arrived; reformatting through a number would truncate above 2^53.
		template.element.textContent = row.data ? row.data.rva : '';
		// A function's first row is two lines tall and the address belongs beside
		// the instruction, not beside the name — the header line is about the
		// function, and repeating the address there would read as a second row.
		template.element.classList.toggle('delver-listing-second-line', this.isFunctionStart(row));
	}

	disposeTemplate(): void { }
}

interface IInstructionTemplate {
	readonly row: HTMLElement;
	readonly functionLabel: HTMLElement;
	readonly mnemonic: HTMLElement;
	readonly operands: HTMLElement;
	readonly disposables: DisposableStore;
	/** Branch target of the row currently in this reused template, if any. */
	target: string | undefined;
}

class InstructionRenderer implements ITableRenderer<IListingRow, IInstructionTemplate> {
	static readonly TEMPLATE_ID = 'delver.listing.instruction';
	readonly templateId = InstructionRenderer.TEMPLATE_ID;

	constructor(
		private readonly onFollow: (target: string) => void,
		private readonly functionLabelFor: (rva: string) => string | undefined,
	) { }

	renderTemplate(container: HTMLElement): IInstructionTemplate {
		const row = dom.append(container, dom.$('.delver-listing-instruction'));
		const template: IInstructionTemplate = {
			row,
			functionLabel: dom.append(row, dom.$('.delver-listing-function-label')),
			mnemonic: dom.append(row, dom.$('.delver-listing-mnemonic')),
			operands: dom.append(row, dom.$('.delver-listing-operands')),
			disposables: new DisposableStore(),
			target: undefined,
		};

		// The handler is bound once per template, not once per row: templates are
		// recycled as the list scrolls, so the current target is read at click
		// time rather than captured.
		template.disposables.add(dom.addDisposableListener(template.operands, dom.EventType.CLICK, e => {
			if (template.target !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				this.onFollow(template.target);
			}
		}));

		return template;
	}

	renderElement(row: IListingRow, _index: number, template: IInstructionTemplate): void {
		if (!row.data) {
			// A row whose page is still in flight renders as a placeholder rather
			// than blocking the scroll on a fetch.
			template.mnemonic.textContent = '';
			template.operands.textContent = '';
			template.target = undefined;
			template.functionLabel.textContent = '';
			template.mnemonic.classList.add('delver-listing-pending');
			template.operands.classList.remove('delver-listing-link');
			template.row.classList.remove('delver-listing-function-start');
			return;
		}

		// A function's first instruction carries its name and a rule above it.
		// Without landmarks a listing is an undifferentiated wall and there is no
		// way to tell where one function ends and the next begins.
		const functionLabel = this.functionLabelFor(row.data.rva);
		template.functionLabel.textContent = functionLabel ?? '';
		template.row.classList.toggle('delver-listing-function-start', functionLabel !== undefined);

		template.mnemonic.classList.remove('delver-listing-pending');
		template.mnemonic.textContent = row.data.mnemonic;
		template.operands.textContent = row.data.operands;
		template.mnemonic.classList.toggle('delver-listing-flow', isBranch(row.data.flow));

		// A statically known target is a link, and looks like one. An indirect
		// call has no target this instruction can name, so it stays plain rather
		// than inviting a click that would go nowhere.
		template.target = row.data.branch_target;
		template.operands.classList.toggle('delver-listing-link', template.target !== undefined);
	}

	disposeTemplate(template: IInstructionTemplate): void {
		template.disposables.dispose();
	}
}

function isBranch(flow: FlowKindWire): boolean {
	return flow === FlowKindWire.Call
		|| flow === FlowKindWire.Jump
		|| flow === FlowKindWire.ConditionalJump;
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
