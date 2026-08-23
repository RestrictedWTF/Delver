/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStringWire, StringEncodingWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorsOrder, IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	FocusReason,
	IDelverFocusService,
} from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { DELVER_NAVIGATION_ORIGIN } from '../../delverListing/browser/delverListingContext.js';
import { DelverListingInput } from '../../delverListing/browser/delverListingInput.js';
import { DELVER_STRINGS_EDITOR_ID, DelverStringsInput } from './delverStringsInput.js';

/** Identifies this view on the focus bus, so it can ignore its own echo. */
const FOCUS_ORIGIN = 'delver.editor.strings';

const ROW_HEIGHT = 22;

/** Filter row plus count line, used only when the real ones measure zero. */
const DEFAULT_CHROME_HEIGHT = 60;

export class DelverStringsEditor extends EditorPane {

	static readonly ID = DELVER_STRINGS_EDITOR_ID;

	private container!: HTMLElement;
	private message!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private tableContainer!: HTMLElement;
	private table: WorkbenchTable<IStringWire> | undefined;

	private readonly sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private all: readonly IStringWire[] = [];

	/** Last size the workbench gave this pane. */
	private dimension: Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(DelverStringsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, dom.$('.delver-strings'));

		const filterRow = dom.append(this.container, dom.$('.delver-strings-filter'));
		this.filterInput = dom.append(filterRow, dom.$('input.delver-strings-filter-input')) as HTMLInputElement;
		this.filterInput.type = 'text';
		this.filterInput.placeholder = localize('delverStringsFilter', "Filter strings");

		this.message = dom.append(this.container, dom.$('.delver-strings-message'));
		this.tableContainer = dom.append(this.container, dom.$('.delver-strings-table'));
	}

	override async setInput(
		input: DelverStringsInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);

		this.sessionDisposables.clear();
		this.table = undefined;
		this.all = [];

		const session = this.sessionService.activeSession;
		if (!session) {
			this.message.textContent = localize('delverStringsNoSession', "Open a target first.");
			this.message.style.display = '';
			return;
		}

		this.message.textContent = localize('delverStringsLoading', "Loading strings…");
		this.message.style.display = '';

		let result;
		try {
			result = await this.sessionService.strings();
		} catch (error) {
			this.message.textContent = localize('delverStringsFailed', "Could not read strings: {0}", toMessage(error));
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		this.all = result.strings;
		// The scan cap is a defence against a hostile file, but a search surface
		// that hides results makes a fruitless search meaningless — so say it.
		this.message.textContent = result.truncated
			? localize(
				'delverStringsTruncated',
				"{0} strings — scan limit reached, this image contains more.",
				result.strings.length,
			)
			: localize('delverStringsCount', "{0} strings", result.strings.length);

		this.createTable();
		this.applyFilter();
	}

	private createTable(): void {
		const store = new DisposableStore();
		this.sessionDisposables.value = store;

		// Disposing a list widget does not detach its DOM. Without this, every
		// re-entry into the editor leaves a dead table behind and they stack up,
		// pushing the live one out of view — which reads as a blank page.
		dom.clearNode(this.tableContainer);

		const delegate = new class implements ITableVirtualDelegate<IStringWire> {
			readonly headerRowHeight = 22;
			getHeight(): number {
				return ROW_HEIGHT;
			}
		}();

		const table = store.add(this.instantiationService.createInstance(
			WorkbenchTable,
			'DelverStrings',
			this.tableContainer,
			delegate,
			[
				{
					label: localize('delverStringsAddress', "Address"),
					tooltip: '',
					weight: 0,
					minimumWidth: 140,
					maximumWidth: 140,
					templateId: TextCellRenderer.ADDRESS_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
				{
					label: localize('delverStringsEncoding', "Encoding"),
					tooltip: '',
					weight: 0,
					minimumWidth: 80,
					maximumWidth: 80,
					templateId: TextCellRenderer.ENCODING_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
				{
					label: localize('delverStringsText', "Text"),
					tooltip: '',
					weight: 1,
					templateId: TextCellRenderer.TEXT_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
			],
			[
				new TextCellRenderer(TextCellRenderer.ADDRESS_ID, s => s.rva),
				new TextCellRenderer(TextCellRenderer.ENCODING_ID, s =>
					s.encoding === StringEncodingWire.Utf16Le ? 'UTF-16' : 'ASCII'),
				new TextCellRenderer(TextCellRenderer.TEXT_ID, s => s.text),
			],
			{
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				overrideStyles: { listBackground: editorBackground },
			},
		)) as WorkbenchTable<IStringWire>;
		this.table = table;

		store.add(table.onDidChangeSelection(e => {
			const selected = e.elements[0];
			if (selected) {
				this.focusService.setFocus(
					{ location: { space: 'Image', address: BigInt(selected.rva) } },
					FOCUS_ORIGIN,
					FocusReason.User,
				);
			}
		}));

		store.add(table.onDidOpen(e => {
			if (!e.element || e.browserEvent?.type !== 'dblclick') {
				return;
			}
			void this.openListingAt(e.element).catch(onUnexpectedError);
		}));

		store.add(dom.addDisposableListener(this.filterInput, dom.EventType.INPUT, () => this.applyFilter()));
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	private async openListingAt(row: IStringWire): Promise<void> {
		const session = this.sessionService.activeSession;
		if (!session) {
			return;
		}
		const existing = this.editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.map(identifier => identifier.editor)
			.find((editor): editor is DelverListingInput => editor instanceof DelverListingInput && editor.targetPath === session.targetPath);
		await this.editorService.openEditor(existing ?? new DelverListingInput(session.targetPath), { pinned: true });
		this.focusService.setFocus(
			{ location: { space: 'Image', address: BigInt(row.rva) } },
			DELVER_NAVIGATION_ORIGIN,
			FocusReason.User,
		);
	}

	/**
	 * Applies the filter over the whole set.
	 *
	 * Case-insensitive substring across text and address: an analyst types part
	 * of a URL as readily as part of an address, and making them choose which
	 * field they meant is friction for no gain.
	 */
	private applyFilter(): void {
		const table = this.table;
		if (!table) {
			return;
		}
		const query = this.filterInput.value.trim().toLowerCase();
		const matches = query === ''
			? this.all
			: this.all.filter(s =>
				s.text.toLowerCase().includes(query) || s.rva.toLowerCase().includes(query));

		table.splice(0, table.length, matches);
	}

	/**
	 * Sizes the table from the dimension the workbench supplies.
	 *
	 * Never from `clientHeight`: a hidden pane measures zero, so laying out from
	 * the DOM leaves the table sized to nothing the moment another tab takes the
	 * group — and it stays that way when this one comes back. The filter row and
	 * the count line are the only chrome, and they are measured off the same
	 * pass rather than assumed.
	 */
	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutTable();
	}

	/**
	 * Re-lays out when this pane comes back into view.
	 *
	 * A pane is reused across tab switches and is laid out while hidden, where
	 * both the chrome and the list measure zero — which is exactly the state
	 * that leaves a returned-to tab showing its filter box and nothing else.
	 */
	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.layoutTable();
		}
	}

	private layoutTable(): void {
		const dimension = this.dimension;
		if (!this.table || !dimension) {
			return;
		}
		// Measured rather than assumed, but only trusted when non-zero: a hidden
		// pane reports zero for everything, and subtracting that would leave the
		// table overlapping the chrome instead of under it.
		const chrome = this.filterInput.parentElement!.offsetHeight + this.message.offsetHeight;
		const height = Math.max(0, dimension.height - (chrome > 0 ? chrome : DEFAULT_CHROME_HEIGHT));
		this.table.layout(height, dimension.width);
	}

	override clearInput(): void {
		this.sessionDisposables.clear();
		this.table = undefined;
		this.all = [];
		super.clearInput();
	}
}

interface ICellTemplate {
	readonly element: HTMLElement;
}

/**
 * Renders one cell of plain text.
 *
 * Strings are **attacker-controlled**. `textContent` is the only thing written
 * here; nothing interpolates them into markup, and nothing should.
 */
class TextCellRenderer implements ITableRenderer<IStringWire, ICellTemplate> {
	static readonly ADDRESS_ID = 'delver.strings.address';
	static readonly ENCODING_ID = 'delver.strings.encoding';
	static readonly TEXT_ID = 'delver.strings.text';

	constructor(
		readonly templateId: string,
		private readonly valueOf: (row: IStringWire) => string,
	) { }

	renderTemplate(container: HTMLElement): ICellTemplate {
		return { element: dom.append(container, dom.$('.delver-strings-cell')) };
	}

	renderElement(row: IStringWire, _index: number, template: ICellTemplate): void {
		template.element.textContent = this.valueOf(row);
	}

	disposeTemplate(): void { }
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
