/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDelverAnalysisService } from '../../../../platform/delver/common/delverAnalysisService.js';
import { IRange } from '../../../../platform/delver/common/address.js';
import { FlowKindWire, IFunctionWire, ISectionWire, IStringWire, StringEncodingWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IDelverSurface } from '../../../services/delver/browser/delverSurface.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { containingFunctionRva } from '../../../services/delver/common/delverFunctions.js';
import {
	IDelverSession,
	IDelverSessionService,
} from '../../../services/delver/common/delverSessionService.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { DELVER_SELECTION_NONE, IDelverSelectionService, MenuDelverSelectionContext } from '../../../services/delver/common/delverSelection.js';
import {
	DELVER_LISTING_FOCUSED,
	DELVER_LISTING_PINNED,
	DELVER_NAVIGATION_ORIGIN,
	shouldFollowWhilePinned,
} from './delverListingContext.js';
import { IListingInterpretationPresentation, listingInterpretationPresentation } from './delverListingInterpretation.js';
import { DelverListingModel, IListingRow, IListingStaticRow } from './delverListingModel.js';
import { mouseHistoryDirection } from '../../../services/delver/common/delverMouseNavigation.js';
import { isInstructionHighlighted } from './delverListingHighlights.js';
import { listingAddressLabel, listingMetadataRow } from './delverListingMetadata.js';
import { activeListing, IDelverListingHost, setActiveListing, touchActiveListing } from './delverActiveListing.js';

/** Identifies this view on the focus bus, so it can ignore its own echo. */
const FOCUS_ORIGIN = 'delver.editor.listing';

const ROW_HEIGHT = 22;

/**
 * The disassembly listing, as a plain widget.
 *
 * Deliberately neither an `EditorPane` nor a `ViewPane`: a workspace zone hosts
 * this directly, and `DelverListingEditor` wraps the same class so a listing can
 * also be a torn-off editor tab for comparison workflows
 * (`Docs/design/workspace.md` §3).
 */
export class DelverListingWidget extends Disposable implements IDelverSurface, IDelverListingHost {

	private container!: HTMLElement;
	private message!: HTMLElement;
	private tableContainer!: HTMLElement;
	private table: WorkbenchTable<IListingRow> | undefined;

	private readonly sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly activeRegistration = this._register(new MutableDisposable<IDisposable>());
	private session: IDelverSession | undefined;
	private publishedSession: IDelverSession | undefined;
	private model: DelverListingModel | undefined;

	/** Set while applying a focus change, so it is not echoed straight back. */
	private applyingFocus = false;
	/** Identifies the newest asynchronous focus request. */
	private focusApplication = 0;
	/** Set while an explicit navigation is replacing the virtual buffer. */
	private anchoringBuffer = false;

	private _pinned = false;
	private readonly pinnedContext: IContextKey<boolean>;
	private readonly listingFocusedContext: IContextKey<boolean>;

	/**
	 * Function entry addresses, in the `"0x..."` form rows carry.
	 *
	 * Held as the wire strings so a row lookup is a string hash rather than a
	 * `BigInt` parse per rendered row.
	 */
	private functionStarts = new Set<string>();
	private functions: readonly IFunctionWire[] = [];
	private highlightedRanges: readonly IRange[] = [];
	private sections: readonly ISectionWire[] = [];
	private stringRowsByRva = new Map<bigint, number>();

	/** Absolute ordinal of the row at the top of the viewport. */
	private topRow = 0;

	/** Last size the workbench gave this pane. */
	private dimension: Dimension | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IDelverSelectionService private readonly selectionService: IDelverSelectionService,
	) {
		super();
		this.pinnedContext = DELVER_LISTING_PINNED.bindTo(contextKeyService);
		this.listingFocusedContext = DELVER_LISTING_FOCUSED.bindTo(contextKeyService);
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

	render(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.delver-listing'));
		this.message = dom.append(this.container, dom.$('.delver-listing-message'));
		this.tableContainer = dom.append(this.container, dom.$('.delver-listing-table'));
		this.message.textContent = localize('delverListingAnalyzing', "Analyzing…");

		// Visibility alone cannot say which listing the user is looking at: two
		// side-by-side groups are both visible at once. Focus can, and it works
		// the same whether this widget sits in an editor tab or a workspace zone.
		const focusTracker = this._register(dom.trackFocus(this.container));
		this._register(focusTracker.onDidFocus(() => {
			touchActiveListing(this);
			this.syncListingActiveContext();
		}));
	}

	/**
	 * Points this listing at a target and builds its virtual model.
	 *
	 * Takes the path rather than an `EditorInput` so a workspace zone, which has
	 * no input, can drive it the same way the editor host does.
	 */
	async setTarget(targetPath: string, token: CancellationToken): Promise<void> {
		this.releaseSession();
		this.message.textContent = localize('delverListingAnalyzing', "Analyzing…");
		this.message.style.display = '';

		let handle: IDelverSession;
		try {
			// The session service owns this. Opening it here would tie the
			// analysis to this editor's lifetime, and switching to another tab
			// would tear it down underneath every other view.
			handle = await this.sessionService.openTarget(targetPath);
		} catch (error) {
			this.message.textContent = localize(
				'delverListingFailed',
				"Could not analyze {0}: {1}",
				targetPath,
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
		if (!handle.sessionId || !handle.image) {
			this.message.textContent = localize('delverListingNeedsTarget', "Locate the matching target to open the instruction listing.");
			return;
		}

		this.session = handle;
		this.publishedSession = handle;

		// Metadata and decoded data belong to the listing itself. Load them before
		// constructing the virtual model so their rows have stable ordinals.
		try {
			const [info, { functions }, strings] = await Promise.all([
				this.sessionService.imageInfo(),
				this.sessionService.functions(),
				this.sessionService.strings(),
			]);
			if (this.session !== handle) {
				return;
			}
			this.sections = info.sections;
			this.functions = functions;
			this.functionStarts = new Set(functions.map(f => f.rva));

			const metadata = listingMetadataRow(handle.targetPath, info);
			const prefixRows: readonly IListingStaticRow[] = [{ kind: 'metadata', ...metadata }];
			const stringValues = [...strings.strings].sort(compareStringRvas);
			const suffixRows: readonly IListingStaticRow[] = stringValues.map(value => ({ kind: 'string', value }));
			const firstStringRow = prefixRows.length + handle.image.instruction_count;
			this.stringRowsByRva = new Map(stringValues.map((value, index) => [BigInt(value.rva), firstStringRow + index] as const));

			this.message.style.display = 'none';
			this.createTable(handle, prefixRows, suffixRows);
		} catch (error) {
			this.message.textContent = localize(
				'delverListingDetailsFailed',
				"Could not build the listing: {0}",
				toMessage(error),
			);
			return;
		}
		if (this.session === handle) {
			await this.applyFocus();
		}
	}

	private createTable(handle: IDelverSession, prefixRows: readonly IListingStaticRow[], suffixRows: readonly IListingStaticRow[]): void {
		const store = new DisposableStore();
		this.sessionDisposables.value = store;

		// Disposing a list widget does not detach its DOM. Without this, every
		// re-entry into the editor leaves a dead table behind and they stack up,
		// pushing the live one out of view — which reads as a blank page.
		dom.clearNode(this.tableContainer);

		const model = new DelverListingModel(
			{
				listingWindow: async (startRow, count) =>
					(await this.analysisService.listingWindow(handle.sessionId!, startRow, count)).rows,
			},
			handle.image!.instruction_count,
			prefixRows,
			suffixRows,
		);
		store.add(model);
		this.model = model;
		this.highlightedRanges = this.focusService.focus.selections ?? [];

		// Authored labels share their instruction's element. This preserves the
		// listing's exact row-to-address identity while giving the optional label
		// a fixed height. Comments remain on the instruction line.
		const heightFor = (row: IListingRow) => row.static?.kind === 'metadata'
			? ROW_HEIGHT * row.static.lines.length
			: row.data === undefined
				? ROW_HEIGHT
				: ROW_HEIGHT * this.presentationFor(row.data.rva).heightInLines;
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
					minimumWidth: 180,
					maximumWidth: 180,
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
				new AddressRenderer(
					row => row.data === undefined ? 0 : this.presentationFor(row.data.rva).linesBeforeInstruction,
					rva => listingAddressLabel(rva, this.sections),
				),
				new InstructionRenderer(
					target => this.followTarget(target),
					rva => this.presentationFor(rva),
					rva => this.functionStarts.has(rva),
					row => this.isPseudocodeHighlighted(row),
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

		// Mouse4/Mouse5 share the focus history used by Alt+Left/Alt+Right.
		// Capture them before the list changes selection or Chromium treats them
		// as page navigation. `auxclick` is suppressed separately so it cannot
		// replay the same history movement a second time.
		store.add(dom.addDisposableListener(this.tableContainer, dom.EventType.MOUSE_DOWN, event => {
			const direction = mouseHistoryDirection(event.button);
			if (direction === undefined) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (direction === 'back') {
				this.focusService.back();
			} else {
				this.focusService.forward();
			}
		}, true));
		store.add(dom.addDisposableListener(this.tableContainer, dom.EventType.AUXCLICK, event => {
			if (mouseHistoryDirection(event.button) !== undefined) {
				event.preventDefault();
				event.stopPropagation();
			}
		}, true));

		table.splice(0, table.length, model.rows);
		if (this.dimension) {
			this.layoutTable();
		}

		store.add(model.onDidChangeRows(range => {
			// The table copied these elements when they were spliced in, so
			// updating the model's array is invisible to it and `rerender()`
			// would just redraw the stale placeholders. Replacing the range with
			// the same number of rows leaves total height — and so the scroll
			// position — untouched.
			const selection = table.getSelection();
			const focus = table.getFocus();
			const wasApplyingFocus = this.applyingFocus;
			this.applyingFocus = true;
			try {
				table.splice(range.start, range.count, model.rows.slice(range.start, range.start + range.count));
				table.setFocus(focus);
				table.setSelection(selection);
			} finally {
				this.applyingFocus = wasApplyingFocus;
			}
		}));

		store.add(model.onDidMoveBuffer(() => {
			// Recentring replaces the buffer, so the view has to be put back where
			// it was. Revealing the row that was on top is exact and does not
			// assume a uniform row height — which stopped being true the moment
			// function headers became two lines tall.
			table.splice(0, table.length, model.rows);
			if (!this.anchoringBuffer) {
				const index = model.indexOf(this.topRow);
				if (index !== -1) {
					table.reveal(index, 0);
				}
				this.updateVisibleRange();
			}
		}));

		// `ListView.rerender()` is a no-op when dynamic-height support is off,
		// which this table deliberately uses. Replace the affected row instead.
		store.add(this.interpretationService.onDidChange(event => {
			if (event.edit.anchor.contentHash === handle.contentHash) {
				this.refreshInterpretationAt(event.edit.anchor.rva);
			}
		}));

		store.add(table.onDidScroll(() => this.updateVisibleRange()));
		store.add(table.onDidChangeSelection(e => {
			this.publishFocus(e.elements[0]);
			this.publishSelection(e.elements[0]);
		}));
		store.add(table.onContextMenu(event => {
			// Selecting under the cursor before opening the menu is what makes
			// the menu's `when` clauses describe the row the analyst actually
			// right-clicked, rather than whatever was selected beforehand.
			if (event.element) {
				this.publishSelection(event.element);
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				menuId: MenuDelverSelectionContext,
				contextKeyService: this.contextKeyService,
			});
		}));
		store.add(this.focusService.onDidChangeFocus(e => {
			this.updatePseudocodeHighlights(e.focus.selections ?? []);
			if (e.origin !== FOCUS_ORIGIN && this.shouldFollow(e.reason)) {
				this.applyFocus();
			}
		}));

		this.updateVisibleRange();
	}

	private refreshInterpretationAt(rva: bigint): void {
		const table = this.table;
		const model = this.model;
		if (!table || !model) {
			return;
		}
		const index = model.rows.findIndex(row => row.data !== undefined && BigInt(row.data.rva) === rva);
		if (index === -1) {
			return; // an unloaded row reads the current name when it enters the buffer
		}

		const selection = table.getSelection();
		const focus = table.getFocus();
		table.splice(index, 1, [model.rows[index]]);
		table.setFocus(focus);
		table.setSelection(selection);
	}

	private updateVisibleRange(): void {
		const table = this.table;
		const model = this.model;
		if (!table || !model) {
			return;
		}
		// Approximate: interpretation lines are taller, so this over-estimates how
		// many rows are on screen. Over-estimating only prefetches a little wide,
		// which is the harmless direction to be wrong in.
		const first = model.bufferStart + Math.floor(table.scrollTop / ROW_HEIGHT);
		const visibleRows = Math.max(1, Math.ceil((this.dimension?.height ?? 0) / ROW_HEIGHT));
		this.topRow = first;
		model.setVisibleRange(first, first + visibleRows);
	}

	private presentationFor(rva: string): IListingInterpretationPresentation {
		const contentHash = this.publishedSession?.contentHash;
		const address = BigInt(rva);
		const interpretation = contentHash === undefined
			? undefined
			: this.interpretationService.at({ kind: 'image', contentHash, rva: address });
		return listingInterpretationPresentation(address, this.functionStarts.has(rva), interpretation);
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

	private isPseudocodeHighlighted(row: IListingRow): boolean {
		if (!row.data) {
			return false;
		}
		return isInstructionHighlighted(row.data, this.highlightedRanges);
	}

	private updatePseudocodeHighlights(ranges: readonly IRange[]): void {
		if (sameRanges(this.highlightedRanges, ranges)) {
			return;
		}
		this.highlightedRanges = ranges;
		const table = this.table;
		const model = this.model;
		if (!table || !model || table.length === 0) {
			return;
		}
		const selection = table.getSelection();
		const focus = table.getFocus();
		// WorkbenchTable does not expose ListView's visible-index getters. The
		// listing already uses this conservative estimate for page prefetching;
		// interpretation headers only make it overdraw a few additional rows.
		const first = Math.max(0, Math.floor(table.scrollTop / ROW_HEIGHT) - 2);
		const visibleRows = Math.ceil((this.dimension?.height ?? ROW_HEIGHT) / ROW_HEIGHT) + 4;
		const last = Math.min(table.length - 1, first + visibleRows);
		const wasApplyingFocus = this.applyingFocus;
		this.applyingFocus = true;
		try {
			for (let index = first; index <= last; index++) {
				table.splice(index, 1, [model.rows[index]]);
			}
			table.setFocus(focus);
			table.setSelection(selection);
		} finally {
			this.applyingFocus = wasApplyingFocus;
		}
	}

	/** Returns the entry of the function containing the selected instruction. */
	async selectedFunctionRva(): Promise<bigint | undefined> {
		const selected = this.table?.getFocusedElements()[0] ?? this.table?.getSelectedElements()[0];
		const session = this.session;
		if (!selected?.data || !session) {
			return undefined;
		}
		if (this.functions.length === 0) {
			const { functions } = await this.sessionService.functions();
			if (this.session !== session) {
				return undefined;
			}
			this.functions = functions;
			this.functionStarts = new Set(functions.map(f => f.rva));
		}
		return containingFunctionRva(this.functions, BigInt(selected.data.rva));
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
	/**
	 * Mirrors "is any listing live" into a context key.
	 *
	 * Derived from the shared active-listing stack rather than from this
	 * widget's own focus, so two listings agree: whichever widget updates the
	 * key last computes the same answer. Deliberately not driven by blur —
	 * clicking a toolbar button or opening the context menu moves DOM focus out
	 * of the table, and disabling every action at that moment would make them
	 * unusable by mouse.
	 */
	private syncListingActiveContext(): void {
		this.listingFocusedContext.set(activeListing() !== undefined);
	}

	/**
	 * Reports what kind of object the selected row is.
	 *
	 * A listing row is an instruction unless it is a function's entry — the
	 * distinction is the whole reason "Generate Signature" can be offered here
	 * and nowhere else. String rows come from the appended string table.
	 */
	private publishSelection(row: IListingRow | undefined): void {
		if (!row) {
			this.selectionService.setSelection(DELVER_SELECTION_NONE);
			return;
		}
		if (row.data) {
			this.selectionService.setSelection({
				kind: this.functionStarts.has(row.data.rva) ? 'function' : 'instruction',
				address: row.data.rva,
			});
			return;
		}
		if (row.static?.kind === 'string') {
			this.selectionService.setSelection({ kind: 'string', address: row.static.value.rva });
			return;
		}
		this.selectionService.setSelection(DELVER_SELECTION_NONE);
	}

	private publishFocus(row: IListingRow | undefined): void {
		const address = row?.data
			? BigInt(row.data.rva)
			: row?.static?.kind === 'string'
				? BigInt(row.static.value.rva)
				: undefined;
		if (this.applyingFocus || address === undefined) {
			return;
		}
		this.focusService.setFocus(
			{ location: { space: 'Image', address } },
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

		if (!session.sessionId) {
			return;
		}
		const application = ++this.focusApplication;
		const address = location.address;
		let listingRow = this.stringRowsByRva.get(address);
		if (listingRow === undefined) {
			const rva = `0x${address.toString(16).toUpperCase()}`;
			const instructionRow = await this.analysisService.rowForAddress(session.sessionId, rva, true);
			if (instructionRow === undefined) {
				return;
			}
			listingRow = model.instructionRow(instructionRow);
		}

		// An older address lookup must not move a replacement table or override a
		// newer focus. This also catches a project being closed while RPC was in
		// flight.
		if (
			application !== this.focusApplication
			|| this.session !== session
			|| this.model !== model
			|| this.table !== table
			|| this.focusService.focus.location?.address !== address
		) {
			return;
		}

		// Replacing the buffer splices the table synchronously. Keep the focus-echo
		// guard active for that splice too: otherwise its selection event republishes
		// the old .rdata row and immediately cancels a jump back to .text.
		const wasApplyingFocus = this.applyingFocus;
		this.applyingFocus = true;
		try {
			if (model.indexOf(listingRow) === -1) {
				this.anchoringBuffer = true;
				try {
					model.anchorAt(listingRow);
				} finally {
					this.anchoringBuffer = false;
				}
			}
			const index = model.indexOf(listingRow);
			if (index === -1) {
				return;
			}

			table.reveal(index, 0.5);
			table.setFocus([index]);
			table.setSelection([index]);
			this.updateVisibleRange();
		} finally {
			this.applyingFocus = wasApplyingFocus;
		}
	}

	/**
	 * Sizes the table from the dimension the workbench supplies.
	 *
	 * Never from `clientHeight`: a hidden pane measures zero, so laying out from
	 * the DOM leaves the table sized to nothing the moment another tab takes the
	 * group — and it stays that way when this one comes back.
	 */
	layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutTable();
		this.updateVisibleRange();
	}

	focus(): void {
		this.table?.domFocus();
	}

	private layoutTable(): void {
		if (!this.table || !this.dimension) {
			return;
		}
		const messageHeight = this.message.style.display === 'none' ? 0 : this.message.offsetHeight;
		this.table.layout(Math.max(0, this.dimension.height - messageHeight), this.dimension.width);
	}

	/**
	 * Re-lays out when this pane comes back into view.
	 *
	 * A pane is reused across tab switches, and it is laid out while hidden —
	 * where a list widget measures zero and renders nothing. Sizing it again on
	 * the way back in is what makes a returned-to tab show its rows, and it is
	 * cheap enough to do unconditionally.
	 */
	setVisible(visible: boolean): void {
		this.activeRegistration.value = visible ? setActiveListing(this) : undefined;
		this.syncListingActiveContext();
		if (visible && this.table && this.dimension) {
			this.layoutTable();
			this.table.rerender();
		}
	}

	/** Drops the current target. The host calls this when its input is cleared. */
	clear(): void {
		this.releaseSession();
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
		this.focusApplication++;
		this.sessionDisposables.clear();
		this.table = undefined;
		this.model = undefined;
		this.publishedSession = undefined;
		this.session = undefined;
		this.functionStarts = new Set();
		this.functions = [];
		this.highlightedRanges = [];
		this.sections = [];
		this.stringRowsByRva.clear();
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

	constructor(
		private readonly linesBeforeInstruction: (row: IListingRow) => number,
		private readonly addressLabel: (rva: string) => string,
	) { }

	renderElement(row: IListingRow, _index: number, template: ICellTemplate): void {
		// Addresses arrive as "0x..." strings (ADR 0001) and are displayed as
		// they arrived; reformatting through a number would truncate above 2^53.
		const staticRow = row.static;
		template.element.textContent = row.data
			? this.addressLabel(row.data.rva)
			: staticRow?.kind === 'metadata'
				? staticRow.lines.map(() => staticRow.address).join('\n')
				: staticRow?.kind === 'string'
					? this.addressLabel(staticRow.value.rva)
					: '';
		// The address belongs beside the instruction, not beside an authored label.
		template.element.classList.toggle('delver-listing-second-line', this.linesBeforeInstruction(row) > 0);
		template.element.classList.toggle('delver-listing-metadata-row', row.static?.kind === 'metadata');
		template.element.classList.toggle('delver-listing-data-row', row.static?.kind === 'string');
	}

	disposeTemplate(): void { }
}

interface IInstructionTemplate {
	readonly row: HTMLElement;
	readonly label: HTMLElement;
	readonly mnemonic: HTMLElement;
	readonly operands: HTMLElement;
	readonly comment: HTMLElement;
	readonly tags: HTMLElement;
	readonly disposables: DisposableStore;
	/** Branch target of the row currently in this reused template, if any. */
	target: string | undefined;
}

class InstructionRenderer implements ITableRenderer<IListingRow, IInstructionTemplate> {
	static readonly TEMPLATE_ID = 'delver.listing.instruction';
	readonly templateId = InstructionRenderer.TEMPLATE_ID;

	constructor(
		private readonly onFollow: (target: string) => void,
		private readonly presentationFor: (rva: string) => IListingInterpretationPresentation,
		private readonly isFunctionStart: (rva: string) => boolean,
		private readonly isHighlighted: (row: IListingRow) => boolean,
	) { }

	renderTemplate(container: HTMLElement): IInstructionTemplate {
		const row = dom.append(container, dom.$('.delver-listing-instruction'));
		const label = dom.append(row, dom.$('.delver-listing-interpretation-label'));
		const instructionLine = dom.append(row, dom.$('.delver-listing-instruction-line'));
		const template: IInstructionTemplate = {
			row,
			label,
			mnemonic: dom.append(instructionLine, dom.$('.delver-listing-mnemonic')),
			operands: dom.append(instructionLine, dom.$('.delver-listing-operands')),
			comment: dom.append(instructionLine, dom.$('.delver-listing-comment')),
			tags: dom.append(instructionLine, dom.$('.delver-listing-tags')),
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
		template.row.classList.toggle('delver-listing-metadata-row', row.static?.kind === 'metadata');
		template.row.classList.toggle('delver-listing-data-row', row.static?.kind === 'string');

		if (row.static) {
			template.target = undefined;
			template.label.textContent = '';
			template.tags.textContent = '';
			template.mnemonic.classList.remove('delver-listing-pending', 'delver-listing-flow');
			template.operands.classList.remove('delver-listing-link');
			template.row.classList.remove('delver-listing-function-start', 'delver-listing-pseudocode-highlight');
			if (row.static.kind === 'metadata') {
				template.mnemonic.textContent = '';
				template.operands.textContent = row.static.lines.join('\n');
				template.comment.textContent = '';
			} else {
				const utf16 = row.static.value.encoding === StringEncodingWire.Utf16Le;
				template.mnemonic.textContent = utf16 ? 'dw' : 'db';
				template.operands.textContent = JSON.stringify(row.static.value.text);
				template.comment.textContent = utf16
					? localize('delverListingUtf16String', "UTF-16 string")
					: localize('delverListingAsciiString', "ASCII string");
			}
			return;
		}

		if (!row.data) {
			// A row whose page is still in flight renders as a placeholder rather
			// than blocking the scroll on a fetch.
			template.mnemonic.textContent = '';
			template.operands.textContent = '';
			template.target = undefined;
			template.label.textContent = '';
			template.comment.textContent = '';
			template.tags.textContent = '';
			template.mnemonic.classList.add('delver-listing-pending');
			template.mnemonic.classList.remove('delver-listing-flow');
			template.operands.classList.remove('delver-listing-link');
			template.row.classList.remove('delver-listing-function-start');
			template.row.classList.remove('delver-listing-pseudocode-highlight');
			return;
		}

		// A function's first instruction carries its name and a rule above it.
		// Without landmarks a listing is an undifferentiated wall and there is no
		// way to tell where one function ends and the next begins.
		const presentation = this.presentationFor(row.data.rva);
		template.label.textContent = presentation.label ?? '';
		template.comment.textContent = presentation.comment ?? '';
		template.tags.textContent = presentation.tags ?? '';
		template.row.classList.toggle('delver-listing-function-start', this.isFunctionStart(row.data.rva));
		template.row.classList.toggle('delver-listing-pseudocode-highlight', this.isHighlighted(row));

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

function compareStringRvas(left: IStringWire, right: IStringWire): number {
	const leftRva = BigInt(left.rva);
	const rightRva = BigInt(right.rva);
	return leftRva < rightRva ? -1 : leftRva > rightRva ? 1 : 0;
}

function sameRanges(left: readonly IRange[], right: readonly IRange[]): boolean {
	return left.length === right.length && left.every((range, index) => range.start === right[index].start && range.end === right[index].end);
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
