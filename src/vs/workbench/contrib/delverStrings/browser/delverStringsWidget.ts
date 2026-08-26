/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStringWire, StringEncodingWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IDelverSurface } from '../../../services/delver/browser/delverSurface.js';
import { DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { FocusReason, IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';

const FOCUS_ORIGIN = 'delver.editor.strings';
const ROW_HEIGHT = 22;
const DEFAULT_CHROME_HEIGHT = 60;

/** Strings table shared by the Navigator zone and its tear-off editor host. */
export class DelverStringsWidget extends Disposable implements IDelverSurface {

	private message!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private tableContainer!: HTMLElement;
	private table: WorkbenchTable<IStringWire> | undefined;
	private readonly sessionDisposables = this._register(new MutableDisposable<DisposableStore>());
	private all: readonly IStringWire[] = [];
	private dimension: Dimension | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
	}

	render(parent: HTMLElement): void {
		const container = dom.append(parent, dom.$('.delver-strings'));
		const filterRow = dom.append(container, dom.$('.delver-strings-filter'));
		this.filterInput = dom.append(filterRow, dom.$('input.delver-strings-filter-input')) as HTMLInputElement;
		this.filterInput.type = 'text';
		this.filterInput.placeholder = localize('delverStringsFilter', "Filter strings");
		this.message = dom.append(container, dom.$('.delver-strings-message'));
		this.tableContainer = dom.append(container, dom.$('.delver-strings-table'));
	}

	async setTarget(targetPath: string, token: CancellationToken): Promise<void> {
		this.clear();
		this.message.textContent = localize('delverStringsLoading', "Loading strings…");
		this.message.style.display = '';
		try {
			const active = this.sessionService.activeSession;
			if (active?.targetPath !== targetPath && active?.projectPath !== targetPath) {
				await this.sessionService.openTarget(targetPath);
			}
			const result = await this.sessionService.strings();
			if (token.isCancellationRequested) {
				return;
			}
			this.all = result.strings;
			this.message.textContent = result.truncated
				? localize('delverStringsTruncated', "{0} strings — scan limit reached, this image contains more.", result.strings.length)
				: localize('delverStringsCount', "{0} strings", result.strings.length);
			this.createTable();
			this.applyFilter();
		} catch (error) {
			if (!token.isCancellationRequested) {
				this.message.textContent = localize('delverStringsFailed', "Could not read strings: {0}", toMessage(error));
			}
		}
	}

	private createTable(): void {
		const store = new DisposableStore();
		this.sessionDisposables.value = store;
		dom.clearNode(this.tableContainer);

		const delegate = new class implements ITableVirtualDelegate<IStringWire> {
			readonly headerRowHeight = 22;
			getHeight(): number { return ROW_HEIGHT; }
		}();
		const table = store.add(this.instantiationService.createInstance(
			WorkbenchTable,
			'DelverStrings',
			this.tableContainer,
			delegate,
			[
				{
					label: localize('delverStringsAddress', "Address"), tooltip: '', weight: 0,
					minimumWidth: 140, maximumWidth: 140, templateId: TextCellRenderer.ADDRESS_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
				{
					label: localize('delverStringsEncoding', "Encoding"), tooltip: '', weight: 0,
					minimumWidth: 80, maximumWidth: 80, templateId: TextCellRenderer.ENCODING_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
				{
					label: localize('delverStringsText', "Text"), tooltip: '', weight: 1,
					templateId: TextCellRenderer.TEXT_ID,
					project(row: IStringWire): IStringWire { return row; },
				},
			],
			[
				new TextCellRenderer(TextCellRenderer.ADDRESS_ID, value => value.rva),
				new TextCellRenderer(TextCellRenderer.ENCODING_ID, value => value.encoding === StringEncodingWire.Utf16Le ? 'UTF-16' : 'ASCII'),
				new TextCellRenderer(TextCellRenderer.TEXT_ID, value => value.text),
			],
			{
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				overrideStyles: { listBackground: editorBackground },
			},
		)) as WorkbenchTable<IStringWire>;
		this.table = table;

		store.add(table.onDidChangeSelection(event => {
			const selected = event.elements[0];
			if (selected) {
				this.focusService.setFocus({ location: { space: 'Image', address: BigInt(selected.rva) } }, FOCUS_ORIGIN, FocusReason.User);
			}
		}));
		store.add(table.onDidOpen(event => {
			if (event.element && event.browserEvent?.type === 'dblclick') {
				void this.openWorkspaceAt(event.element).catch(onUnexpectedError);
			}
		}));
		store.add(dom.addDisposableListener(this.filterInput, dom.EventType.INPUT, () => this.applyFilter()));
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	private async openWorkspaceAt(row: IStringWire): Promise<void> {
		const session = this.sessionService.activeSession;
		if (!session) {
			return;
		}
		await this.editorService.openEditor(new DelverWorkspaceInput(session.projectPath ?? session.targetPath), { pinned: true });
		this.focusService.setFocus({ location: { space: 'Image', address: BigInt(row.rva) } }, FOCUS_ORIGIN, FocusReason.User);
	}

	private applyFilter(): void {
		const table = this.table;
		if (!table) {
			return;
		}
		const query = this.filterInput.value.trim().toLowerCase();
		const matches = query === '' ? this.all : this.all.filter(value =>
			value.text.toLowerCase().includes(query) || value.rva.toLowerCase().includes(query));
		table.splice(0, table.length, matches);
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutTable();
	}

	setVisible(visible: boolean): void {
		if (visible) {
			this.layoutTable();
		}
	}

	focus(): void {
		this.table?.domFocus();
	}

	clear(): void {
		this.sessionDisposables.clear();
		this.table = undefined;
		this.all = [];
	}

	private layoutTable(): void {
		const dimension = this.dimension;
		if (!this.table || !dimension) {
			return;
		}
		const chrome = this.filterInput.parentElement!.offsetHeight + this.message.offsetHeight;
		const height = Math.max(0, dimension.height - (chrome > 0 ? chrome : DEFAULT_CHROME_HEIGHT));
		this.table.layout(height, dimension.width);
	}
}

interface ICellTemplate {
	readonly element: HTMLElement;
}

class TextCellRenderer implements ITableRenderer<IStringWire, ICellTemplate> {
	static readonly ADDRESS_ID = 'delver.strings.address';
	static readonly ENCODING_ID = 'delver.strings.encoding';
	static readonly TEXT_ID = 'delver.strings.text';

	constructor(readonly templateId: string, private readonly valueOf: (row: IStringWire) => string) { }

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
