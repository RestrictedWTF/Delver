/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
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
	private table: WorkbenchTable<IListingRow> | undefined;

	private readonly sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private session: IAnalysisSessionHandle | undefined;
	private publishedSession: IDelverSession | undefined;
	private model: DelverListingModel | undefined;

	/** Set while applying a focus change, so it is not echoed straight back. */
	private applyingFocus = false;

	private _pinned = false;
	private readonly pinnedContext: IContextKey<boolean>;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDelverAnalysisService private readonly analysisService: IDelverAnalysisService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
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

		let handle: IAnalysisSessionHandle;
		try {
			handle = await this.analysisService.openImage({ kind: 'file', path: input.targetPath });
		} catch (error) {
			this.message.textContent = localize(
				'delverListingFailed',
				"Could not analyze {0}: {1}",
				input.targetPath,
				toMessage(error),
			);
			return;
		}

		// The editor may have been closed or retargeted while analysis ran.
		if (token.isCancellationRequested) {
			this.analysisService.closeImage(handle.sessionId);
			return;
		}

		this.session = handle;
		this.publishedSession = {
			sessionId: handle.sessionId,
			targetPath: input.targetPath,
			image: handle.image,
		};
		this.sessionService.setActiveSession(this.publishedSession);
		this.message.style.display = 'none';
		this.createTable(handle);
	}

	private createTable(handle: IAnalysisSessionHandle): void {
		const store = new DisposableStore();
		this.sessionDisposables.value = store;

		const model = new DelverListingModel(
			{
				listingWindow: async (startRow, count) =>
					(await this.analysisService.listingWindow(handle.sessionId, startRow, count)).rows,
			},
			handle.image.instruction_count,
		);
		store.add(model);
		this.model = model;

		const delegate = new class implements ITableVirtualDelegate<IListingRow> {
			readonly headerRowHeight = 0;
			getHeight(): number {
				return ROW_HEIGHT;
			}
		}();

		const table = store.add(this.instantiationService.createInstance(
			WorkbenchTable,
			'DelverListing',
			this.container,
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
			[new AddressRenderer(), new InstructionRenderer(target => this.followTarget(target))],
			{
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				overrideStyles: { listBackground: editorBackground },
			},
		)) as WorkbenchTable<IListingRow>;
		this.table = table;

		table.splice(0, table.length, model.rows);
		table.layout(this.container.clientHeight, this.container.clientWidth);

		store.add(model.onDidChangeRows(range => {
			// The table copied these elements when they were spliced in, so
			// updating the model's array is invisible to it and `rerender()`
			// would just redraw the stale placeholders. Replacing the range with
			// the same number of rows leaves total height — and so the scroll
			// position — untouched.
			table.splice(range.start, range.count, model.rows.slice(range.start, range.start + range.count));
		}));

		store.add(model.onDidMoveBuffer(delta => {
			const scrollTop = table.scrollTop;
			table.splice(0, table.length, model.rows);
			// Every row that left the front of the buffer shifts content up by
			// one row height. Without this correction the view jumps by half a
			// buffer the moment it recentres.
			table.scrollTop = Math.max(0, scrollTop - delta * ROW_HEIGHT);
			this.updateVisibleRange();
		}));

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
		const first = model.bufferStart + Math.floor(table.scrollTop / ROW_HEIGHT);
		const visibleRows = Math.max(1, Math.ceil(this.container.clientHeight / ROW_HEIGHT));
		model.setVisibleRange(first, first + visibleRows);
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

	override layout(): void {
		const table = this.table;
		if (table) {
			table.layout(this.container.clientHeight, this.container.clientWidth);
			this.updateVisibleRange();
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

	private releaseSession(): void {
		this.sessionDisposables.clear();
		this.table = undefined;
		this.model = undefined;

		// Passed as `previous` so this cannot clear a session that a later
		// listing already published — closing one editor must not blind
		// navigation in the one that replaced it.
		const published = this.publishedSession;
		this.publishedSession = undefined;
		if (published) {
			this.sessionService.setActiveSession(undefined, published);
		}

		const session = this.session;
		this.session = undefined;
		if (session) {
			// The session owns two child processes; leaving it open would leak
			// them for the lifetime of the window.
			this.analysisService.closeImage(session.sessionId).catch(() => undefined);
		}
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

	renderElement(row: IListingRow, _index: number, template: ICellTemplate): void {
		// Addresses arrive as "0x..." strings (ADR 0001) and are displayed as
		// they arrived; reformatting through a number would truncate above 2^53.
		template.element.textContent = row.data ? row.data.rva : '';
	}

	disposeTemplate(): void { }
}

interface IInstructionTemplate {
	readonly mnemonic: HTMLElement;
	readonly operands: HTMLElement;
	readonly disposables: DisposableStore;
	/** Branch target of the row currently in this reused template, if any. */
	target: string | undefined;
}

class InstructionRenderer implements ITableRenderer<IListingRow, IInstructionTemplate> {
	static readonly TEMPLATE_ID = 'delver.listing.instruction';
	readonly templateId = InstructionRenderer.TEMPLATE_ID;

	constructor(private readonly onFollow: (target: string) => void) { }

	renderTemplate(container: HTMLElement): IInstructionTemplate {
		const row = dom.append(container, dom.$('.delver-listing-instruction'));
		const template: IInstructionTemplate = {
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
			template.mnemonic.classList.add('delver-listing-pending');
			template.operands.classList.remove('delver-listing-link');
			return;
		}

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
