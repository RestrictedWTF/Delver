/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IView } from '../../../../base/browser/ui/splitview/splitview.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IDelverSurface } from '../../../services/delver/browser/delverSurface.js';
import { companionSurfaceIds, IDelverSurfaceContext, IDelverSurfaceDescriptor } from '../../../services/delver/browser/delverSurfaceRegistry.js';

const HEADER_HEIGHT_FALLBACK = 32;

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
		const headerHeight = this.tabs.parentElement?.offsetHeight || HEADER_HEIGHT_FALLBACK;
		const visibleWidth = this.visibleIds.length > 0 ? this.width / this.visibleIds.length : this.width;
		for (const id of this.visibleIds) {
			this.hosted.get(id)?.surface.layout(new Dimension(visibleWidth, Math.max(0, this.height - headerHeight)));
		}
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
