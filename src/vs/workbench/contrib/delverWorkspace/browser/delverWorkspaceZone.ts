/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { IView } from '../../../../base/browser/ui/splitview/splitview.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IDelverSurface } from '../../../services/delver/browser/delverSurface.js';
import { companionSurfaceIds, IDelverSurfaceContext, IDelverSurfaceDescriptor } from '../../../services/delver/browser/delverSurfaceRegistry.js';

const HEADER_HEIGHT_FALLBACK = 32;

/**
 * Narrowest either side of the companion split may become, in pixels.
 *
 * A pane dragged to nothing cannot be dragged back — the sash lands on top of
 * the zone edge and there is no visible handle left to grab.
 */
const MINIMUM_COMPANION_WIDTH = 120;

interface IHostedSurface {
	readonly descriptor: IDelverSurfaceDescriptor;
	readonly surface: IDelverSurface;
	readonly container: HTMLElement;
	readonly tab: HTMLButtonElement;
	readonly disposables: DisposableStore;
	readonly contextOperation: MutableDisposable<IDisposable>;
	lastContextKey: string | undefined;
}

/** One independent workspace column and its full-height surface segments. */
export class DelverWorkspaceZone extends Disposable implements IView<number> {

	readonly element: HTMLElement;
	readonly minimumSize: number;
	readonly maximumSize = Number.POSITIVE_INFINITY;
	readonly onDidChange = Event.None;

	private readonly tabs: HTMLElement;
	private readonly body: HTMLElement;
	private readonly hosted = new Map<string, IHostedSurface>();
	private visibleIds: readonly string[] = [];
	private companions: ReadonlySet<string> = new Set();
	private readonly companionsOf = new Map<string, readonly string[]>();
	private context: IDelverSurfaceContext | undefined;
	private zoneVisible = true;
	private width = 0;
	private height = 0;
	private readonly sash: Sash;
	/** Fraction of the zone's width given to the first of two visible surfaces. */
	private splitRatio = 0.5;
	private sashStartWidth = 0;

	constructor(
		title: string,
		minimumSize: number,
		private readonly createSurface: (descriptor: IDelverSurfaceDescriptor) => IDelverSurface,
		private readonly selectSurface: (id: string) => void,
		/**
		 * Fills the header's state slot — pin and sync only, never actions.
		 * Passed as a callback so the zone needs no services of its own and
		 * stays constructible in a test.
		 */
		renderChrome?: (container: HTMLElement) => IDisposable,
		/**
		 * Right-click on a segment tab. The host decides what to offer, because
		 * tearing a surface off means opening an `EditorInput` and the zone has
		 * no editor service of its own.
		 */
		private readonly onSegmentContextMenu?: (id: string, anchor: HTMLElement) => void,
		/** Persists the companion split when the analyst drags it. */
		private readonly onDidChangeSplitRatio?: (ratio: number) => void,
	) {
		super();
		this.minimumSize = minimumSize;
		this.element = dom.$('.delver-workspace-zone');
		const header = dom.append(this.element, dom.$('.delver-workspace-zone-header'));
		const heading = dom.append(header, dom.$('.delver-workspace-zone-title'));
		heading.textContent = title;
		this.tabs = dom.append(header, dom.$('.delver-workspace-segments'));
		this.tabs.setAttribute('role', 'tablist');
		if (renderChrome) {
			this._register(renderChrome(dom.append(header, dom.$('.delver-workspace-zone-chrome'))));
		}
		this.body = dom.append(this.element, dom.$('.delver-workspace-zone-body'));

		// Listing and Pseudocode share this zone, and how much of it each
		// deserves depends on what is being read — a dense loop wants the
		// disassembly wide, a long function wants the C. The even split is only a
		// starting point, so the boundary is draggable.
		this.sash = this._register(new Sash(this.body, {
			getVerticalSashLeft: () => this.firstSurfaceWidth(),
			getVerticalSashHeight: () => Math.max(0, this.height - this.headerHeight()),
		}, { orientation: Orientation.VERTICAL }));
		this._register(this.sash.onDidStart(() => {
			this.sashStartWidth = this.firstSurfaceWidth();
		}));
		this._register(this.sash.onDidChange(event => {
			if (this.width <= 0) {
				return;
			}
			const limit = Math.min(MINIMUM_COMPANION_WIDTH, this.width / 2);
			const width = Math.max(limit, Math.min(this.width - limit, this.sashStartWidth + event.currentX - event.startX));
			this.splitRatio = width / this.width;
			this.layoutVisibleSurfaces();
		}));
		this._register(this.sash.onDidEnd(() => this.onDidChangeSplitRatio?.(this.splitRatio)));
		// Double-click restores the even split, which is the only way back to it
		// once dragged and the conventional gesture for exactly that.
		this._register(this.sash.onDidReset(() => {
			this.splitRatio = 0.5;
			this.layoutVisibleSurfaces();
			this.onDidChangeSplitRatio?.(this.splitRatio);
		}));
		this.sash.state = SashState.Disabled;
	}

	/** Restores a persisted companion split. */
	setSplitRatio(ratio: number): void {
		if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
			return;
		}
		this.splitRatio = ratio;
		this.layoutVisibleSurfaces();
	}

	private headerHeight(): number {
		return this.tabs.parentElement?.offsetHeight || HEADER_HEIGHT_FALLBACK;
	}

	/** Width of the first surface when two share the zone. */
	private firstSurfaceWidth(): number {
		return Math.round(this.width * this.splitRatio);
	}

	setDescriptors(descriptors: readonly IDelverSurfaceDescriptor[]): void {
		this.companions = companionSurfaceIds(descriptors);
		this.companionsOf.clear();
		for (const descriptor of descriptors) {
			if (descriptor.companions?.length) {
				this.companionsOf.set(descriptor.id, descriptor.companions);
			}
		}
		const nextIds = new Set(descriptors.map(descriptor => descriptor.id));
		for (const [id, hosted] of this.hosted) {
			if (!nextIds.has(id) || descriptors.find(descriptor => descriptor.id === id) !== hosted.descriptor) {
				hosted.disposables.dispose();
				hosted.container.remove();
				hosted.tab.remove();
				this.hosted.delete(id);
			}
		}

		for (const descriptor of descriptors) {
			if (this.hosted.has(descriptor.id)) {
				continue;
			}
			const disposables = new DisposableStore();
			const surface = disposables.add(this.createSurface(descriptor));
			const container = dom.append(this.body, dom.$('.delver-workspace-surface'));
			container.dataset.surfaceId = descriptor.id;
			const tab = dom.append(this.tabs, dom.$('button.delver-workspace-segment')) as HTMLButtonElement;
			tab.type = 'button';
			tab.setAttribute('role', 'tab');
			tab.title = descriptor.title.value;
			// A companion rides its host's tab, so it must not offer one.
			tab.classList.toggle('companion', this.companions.has(descriptor.id));
			const contextOperation = disposables.add(new MutableDisposable<IDisposable>());
			const hosted: IHostedSurface = { descriptor, surface, container, tab, disposables, contextOperation, lastContextKey: undefined };
			this.hosted.set(descriptor.id, hosted);
			this.updateTabLabel(hosted, undefined);
			disposables.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => this.selectSurface(descriptor.id)));
			disposables.add(dom.addDisposableListener(tab, dom.EventType.CONTEXT_MENU, event => {
				event.preventDefault();
				this.onSegmentContextMenu?.(descriptor.id, tab);
			}));
			if (descriptor.badge) {
				disposables.add(descriptor.badge(count => this.updateTabLabel(hosted, count)));
			}
			surface.render(container);
			surface.setVisible(false);
		}

		for (const descriptor of descriptors) {
			const hosted = this.hosted.get(descriptor.id);
			if (hosted) {
				this.tabs.append(hosted.tab);
				this.body.append(hosted.container);
			}
		}

		// Reconcile against `hosted` rather than trusting that every stale node was
		// removed on the way here. Tabs are created once per id and moved, never
		// copied, so an orphan should be impossible — but a duplicated segment is
		// both very visible and very confusing, and this makes it unrepresentable
		// instead of merely unlikely.
		const live = new Set<Element>();
		for (const hosted of this.hosted.values()) {
			live.add(hosted.tab);
			live.add(hosted.container);
		}
		for (const node of [...this.tabs.children]) {
			if (!live.has(node)) {
				node.remove();
			}
		}
		for (const node of [...this.body.children]) {
			if (!live.has(node)) {
				node.remove();
			}
		}

		const selectable = descriptors.filter(descriptor => !this.companions.has(descriptor.id));
		const retained = this.visibleIds.filter(id => this.hosted.has(id) && !this.companions.has(id));
		this.show(retained.length > 0 ? retained : selectable[0] ? [selectable[0].id] : []);
	}

	show(ids: readonly string[]): void {
		const expanded: string[] = [];
		for (const id of ids) {
			expanded.push(id, ...(this.companionsOf.get(id) ?? []));
		}
		const next = expanded.filter((id, index) => this.hosted.has(id) && expanded.indexOf(id) === index);
		this.visibleIds = next;
		for (const [id, hosted] of this.hosted) {
			const visible = this.zoneVisible && next.includes(id);
			hosted.container.classList.toggle('active', visible);
			// Anything after the first visible surface sits beside a sibling and
			// needs a rule between them.
			hosted.container.classList.toggle('side-by-side', visible && next.indexOf(id) > 0);
			hosted.tab.classList.toggle('active', visible);
			hosted.tab.setAttribute('aria-selected', String(visible));
			hosted.surface.setVisible(visible);
			if (visible) {
				this.bindContext(hosted);
			} else {
				hosted.contextOperation.clear();
			}
		}
		this.layoutVisibleSurfaces();
	}

	setZoneVisible(visible: boolean): void {
		if (this.zoneVisible === visible) {
			return;
		}
		this.zoneVisible = visible;
		this.show(this.visibleIds);
	}

	setContext(context: IDelverSurfaceContext): void {
		// Recorded even while hidden, so `show()` can bind the current context on
		// the way back in — but no binding is issued now. `visibleIds` names the
		// *selected* segments, which stay selected while the zone itself is
		// hidden; binding off that alone would send analysis requests for a
		// workspace nobody is looking at.
		this.context = context;
		if (!this.zoneVisible) {
			return;
		}
		for (const id of this.visibleIds) {
			const hosted = this.hosted.get(id);
			if (hosted) {
				this.bindContext(hosted);
			}
		}
	}

	focus(): void {
		this.hosted.get(this.visibleIds[0] ?? '')?.surface.focus();
	}

	layout(size: number, _offset: number, height: number | undefined): void {
		this.width = size;
		this.height = height ?? 0;
		this.layoutVisibleSurfaces();
	}

	private bindContext(hosted: IHostedSurface): void {
		const context = this.context;
		const setContext = hosted.descriptor.setContext;
		if (!context || !setContext) {
			return;
		}
		const contextKey = hosted.descriptor.contextKey?.(context);
		if (contextKey !== undefined && contextKey === hosted.lastContextKey) {
			return;
		}
		hosted.lastContextKey = contextKey;
		const source = new CancellationTokenSource();
		let settled = false;
		// Held as a disposable that *cancels*. `CancellationTokenSource.dispose()`
		// defaults to `cancel: false`, so storing the source directly would let
		// `contextOperation.clear()` — which is how hiding a segment tears this
		// down — drop the source without cancelling, and the in-flight binding
		// would still land in a surface the analyst can no longer see.
		hosted.contextOperation.value = toDisposable(() => {
			source.dispose(true);
			// Torn down before it finished: the surface never received this
			// context, so the memo must not claim it did. Leaving it set would
			// make the next `show()` skip the rebind and strand the segment
			// showing whatever it held before.
			if (!settled) {
				hosted.lastContextKey = undefined;
			}
		});
		Promise.resolve(setContext(hosted.surface, context, source.token)).then(() => {
			settled = true;
		}, error => {
			settled = true;
			if (!source.token.isCancellationRequested) {
				onUnexpectedError(error);
			}
		});
	}

	private layoutVisibleSurfaces(): void {
		if (this.width <= 0 || this.height <= 0) {
			return;
		}
		const height = Math.max(0, this.height - this.headerHeight());
		// The sash only makes sense for exactly two surfaces. Three would need a
		// sash each and a policy for which one a drag steals from; nothing in the
		// design puts three in a zone, so this stays an even split rather than
		// guessing.
		const split = this.visibleIds.length === 2;
		this.sash.state = split ? SashState.Enabled : SashState.Disabled;
		const first = split ? this.firstSurfaceWidth() : 0;
		for (const [index, id] of this.visibleIds.entries()) {
			const hosted = this.hosted.get(id);
			if (!hosted) {
				continue;
			}
			const width = split
				? (index === 0 ? first : this.width - first)
				: this.width / Math.max(1, this.visibleIds.length);
			// `flex` alone would re-divide the zone evenly and undo the drag.
			hosted.container.style.flex = `0 0 ${width}px`;
			hosted.surface.layout(new Dimension(width, height));
		}
		this.sash.layout();
	}

	private updateTabLabel(hosted: IHostedSurface, count: number | undefined): void {
		hosted.tab.textContent = count === undefined
			? hosted.descriptor.title.value
			: `${hosted.descriptor.title.value} · ${count}`;
	}

	override dispose(): void {
		for (const hosted of this.hosted.values()) {
			hosted.disposables.dispose();
		}
		this.hosted.clear();
		super.dispose();
	}
}
