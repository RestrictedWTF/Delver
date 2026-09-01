/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/delverWorkspace.css';

import * as dom from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFunctionWire } from '../../../../platform/delver/common/protocol.generated.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { SyncDescriptor0 } from '../../../../platform/instantiation/common/descriptors.js';
import { DelverSurfaceId, DelverZone, IDelverSurface, MenuDelverPrimaryChrome } from '../../../services/delver/browser/delverSurface.js';
import { allDelverSurfaces, IDelverSurfaceContext, IDelverSurfaceDescriptor, onDidChangeDelverSurfaces, surfacesForZone, zoneForSurface } from '../../../services/delver/browser/delverSurfaceRegistry.js';
import { DELVER_WORKSPACE_EDITOR_ID, DelverWorkspaceInput } from '../../../services/delver/browser/delverWorkspaceInput.js';
import { DelverRecentTargetsStore, DelverWorkspaceStateStore, IDelverWorkspaceState } from '../../../services/delver/browser/delverWorkspaceState.js';
import { IDelverFocusService } from '../../../services/delver/common/delverFocusService.js';
import { containingFunctionRva } from '../../../services/delver/common/delverFunctions.js';
import { IDelverInterpretationService } from '../../../services/delver/common/delverInterpretationService.js';
import { IDelverSession, IDelverSessionService } from '../../../services/delver/common/delverSessionService.js';
import { IDelverWorkspaceService } from '../../../services/delver/common/delverWorkspaceService.js';
import { mouseHistoryDirection } from '../../../services/delver/common/delverMouseNavigation.js';
import { DelverWorkspaceZone } from './delverWorkspaceZone.js';

const NAVIGATOR_MINIMUM_WIDTH = 180;
/** Fits the zone name plus its three segment labels without clipping either. */
const NAVIGATOR_DEFAULT_WIDTH = 280;
const PRIMARY_MINIMUM_WIDTH = 360;
const INSPECTOR_MINIMUM_WIDTH = 220;
const HEADER_HEIGHT_FALLBACK = 32;

/** Hosts one target's three-zone Delver workspace in the editor area. */
export class DelverWorkspaceEditor extends EditorPane {

	static readonly ID = DELVER_WORKSPACE_EDITOR_ID;

	private root!: HTMLElement;
	private targetLabel!: HTMLElement;
	private targetMetadata!: HTMLElement;
	private splitContainer!: HTMLElement;
	private splitView!: SplitView<number>;
	private navigator!: DelverWorkspaceZone;
	private primary!: DelverWorkspaceZone;
	private inspector!: DelverWorkspaceZone;
	private dimension: Dimension | undefined;
	private editorVisible = true;
	private targetPath: string | undefined;
	private session: IDelverSession | undefined;
	private functions: readonly IFunctionWire[] = [];
	private state: IDelverWorkspaceState | undefined;
	private restoreWidths = false;

	private readonly inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	/** Cancels a superseded function refresh so a slow one cannot land last. */
	private readonly functionsRefresh = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly stateStore: DelverWorkspaceStateStore;
	private readonly recentTargets: DelverRecentTargetsStore;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IDelverSessionService private readonly sessionService: IDelverSessionService,
		@IDelverFocusService private readonly focusService: IDelverFocusService,
		@IDelverInterpretationService private readonly interpretationService: IDelverInterpretationService,
		@IDelverWorkspaceService private readonly workspaceService: IDelverWorkspaceService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(DelverWorkspaceEditor.ID, group, telemetryService, themeService, storageService);
		this.stateStore = new DelverWorkspaceStateStore(storageService);
		this.recentTargets = new DelverRecentTargetsStore(storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, dom.$('.delver-workspace'));
		const header = dom.append(this.root, dom.$('.delver-workspace-header'));
		this.targetLabel = dom.append(header, dom.$('.delver-workspace-target'));
		this.targetMetadata = dom.append(header, dom.$('.delver-workspace-metadata'));
		// Zone visibility lives beside the target's identity, because it is a
		// property of this workspace rather than of any one zone — and a control
		// for hiding a zone cannot live inside the zone it hides.
		const zones = dom.append(header, dom.$('button.delver-workspace-zones')) as HTMLButtonElement;
		zones.type = 'button';
		zones.title = localize('delverWorkspaceZonesTitle', "Toggle Zones");
		zones.appendChild(renderIcon(Codicon.menu));
		this._register(dom.addDisposableListener(zones, dom.EventType.CLICK, () => this.showZoneMenu(zones)));

		// Mouse4/Mouse5 anywhere in the workspace, not only over the listing
		// table — over pseudocode, the trees and the zone chrome they previously
		// did nothing at all.
		//
		// Deliberately the **bubble** phase. The listing binds the same buttons in
		// capture and stops propagation there, which only suppresses this handler
		// if this one runs later; a capture listener on the root is an ancestor's,
		// so it would run *first* and move the history twice for every click on
		// the table. Bubbling also keeps the listing's own handler authoritative
		// where it exists, including in a torn-off listing editor with no
		// workspace above it.
		this._register(dom.addDisposableListener(this.root, dom.EventType.MOUSE_DOWN, event => {
			const direction = mouseHistoryDirection(event.button);
			if (direction === undefined) {
				return;
			}
			event.preventDefault();
			if (direction === 'back') {
				this.focusService.back();
			} else {
				this.focusService.forward();
			}
		}));
		this._register(dom.addDisposableListener(this.root, dom.EventType.AUXCLICK, event => {
			if (mouseHistoryDirection(event.button) !== undefined) {
				event.preventDefault();
			}
		}));

		this.splitContainer = dom.append(this.root, dom.$('.delver-workspace-split'));
		// `createInstance`'s descriptor overload is typed for `SyncDescriptor0`,
		// so a `SyncDescriptor<T>` carrying static arguments — which
		// `registerDelverTreeSurface` uses to pass each `ITreeView` — falls
		// through to the `unknown`-returning overload. The cast only selects the
		// intended overload: `createInstance` applies a descriptor's static
		// arguments at runtime either way, and the descriptor is the registry's
		// own, so `T` really is an `IDelverSurface`.
		const createSurface = (descriptor: IDelverSurfaceDescriptor): IDelverSurface =>
			this.instantiationService.createInstance(descriptor.ctor as SyncDescriptor0<IDelverSurface>);
		this.navigator = this._register(new DelverWorkspaceZone(
			localize('delverWorkspaceNavigator', "Navigator"),
			NAVIGATOR_MINIMUM_WIDTH,
			createSurface,
			id => this.selectNavigator(id),
			undefined,
			(id, anchor) => this.showSegmentContextMenu(id, anchor),
		));
		this.primary = this._register(new DelverWorkspaceZone(
			localize('delverWorkspacePrimary', "Primary"),
			PRIMARY_MINIMUM_WIDTH,
			createSurface,
			id => this.selectPrimary(id),
			container => this.instantiationService.createInstance(MenuWorkbenchToolBar, container, MenuDelverPrimaryChrome, {
				// State toggles only, so an overflow menu would be hiding two
				// controls that `principles.md` §5 requires to stay visible.
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				toolbarOptions: { primaryGroup: 'navigation' },
			}),
			(id, anchor) => this.showSegmentContextMenu(id, anchor),
			ratio => this.savePrimarySplitRatio(ratio),
		));
		this.inspector = this._register(new DelverWorkspaceZone(
			localize('delverWorkspaceInspector', "Inspector"),
			INSPECTOR_MINIMUM_WIDTH,
			createSurface,
			id => this.selectInspector(id),
			undefined,
			(id, anchor) => this.showSegmentContextMenu(id, anchor),
		));

		this.splitView = this._register(new SplitView<number>(this.splitContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: false,
		}));
		this.splitView.addView(this.navigator, NAVIGATOR_DEFAULT_WIDTH);
		this.splitView.addView(this.primary, 600);
		this.splitView.addView(this.inspector, 280);
		this._register(this.splitView.onDidSashChange(() => this.saveWidths()));
	}

	override async setInput(
		input: DelverWorkspaceInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);
		this.inputDisposables.clear();
		this.targetPath = input.targetPath;
		this.recentTargets.add(input.targetPath);
		this.state = this.stateStore.load(input.targetPath);
		this.restoreWidths = true;
		this.targetLabel.textContent = input.getName();
		this.targetMetadata.textContent = localize('delverWorkspaceOpening', "Opening target…");
		this.refreshDescriptors();
		this.applyVisibleState();

		let session: IDelverSession;
		try {
			session = await this.sessionService.openTarget(input.targetPath);
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error)) {
				this.targetMetadata.textContent = localize('delverWorkspaceOpenFailed', "Could not open target: {0}", toMessage(error));
			}
			return;
		}
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}

		this.session = session;
		this.sessionService.setActiveTarget(input.targetPath);
		await this.refreshFunctions(token);
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}
		this.updateHeader();
		this.updateSurfaceContext();

		const store = new DisposableStore();
		this.inputDisposables.value = store;
		store.add(onDidChangeDelverSurfaces(() => {
			this.refreshDescriptors();
			this.applyVisibleState();
			this.updateSurfaceContext();
		}));
		store.add(this.contextKeyService.onDidChangeContext(() => {
			this.refreshDescriptors();
			this.applyVisibleState();
			this.updateSurfaceContext();
		}));
		// A hidden workspace must not act on global events. Its listeners stay
		// live for as long as an input is set, so with two targets open an
		// address focus in one would flip the other's primary mode — and
		// `selectPrimary` persists, silently rewriting the hidden target's
		// saved state. `setEditorVisible` resyncs context on the way back in.
		store.add(this.focusService.onDidChangeFocus(event => {
			if (!this.editorVisible) {
				return;
			}
			if (event.focus.location?.space === 'Image') {
				this.selectPrimary(DelverSurfaceId.Listing);
			}
			this.updateSurfaceContext();
		}));
		store.add(this.workspaceService.onDidRequestSurface(id => {
			if (this.editorVisible) {
				this.showRequestedSurface(id);
			}
		}));
		store.add(this.sessionService.onDidChangeActiveSession(changed => {
			if (!changed) {
				return;
			}
			this.session = changed;
			const source = new CancellationTokenSource();
			this.functionsRefresh.value = source;
			void this.refreshFunctions(source.token).then(() => {
				if (source.token.isCancellationRequested || this.input !== input) {
					return;
				}
				this.updateHeader();
				this.updateSurfaceContext();
			}).catch(onUnexpectedError);
		}));

		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		const headerHeight = this.targetLabel.parentElement?.offsetHeight || HEADER_HEIGHT_FALLBACK;
		const bodyHeight = Math.max(0, dimension.height - headerHeight);
		this.splitView.layout(dimension.width, bodyHeight);
		if (this.restoreWidths && this.state) {
			this.restoreWidths = false;
			this.splitView.resizeView(0, this.state.navigatorWidth);
			this.splitView.resizeView(2, this.state.inspectorWidth);
			this.primary.setSplitRatio(this.state.primarySplitRatio);
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.editorVisible = visible;
		this.navigator.setZoneVisible(visible);
		this.primary.setZoneVisible(visible);
		this.inspector.setZoneVisible(visible);
		if (visible && this.dimension) {
			// Claim the implicit API for this workspace's target. Sessions are
			// per-target (ADR 0008) but `functions()`, `imports()` and the rest
			// still answer for whichever is active, so the workspace on screen
			// has to be the one they answer for.
			if (this.targetPath) {
				this.sessionService.setActiveTarget(this.targetPath);
			}
			this.layout(this.dimension);
			// Focus moved while this workspace was hidden and it deliberately
			// ignored those events, so its surfaces hold the context from
			// whenever it was last shown. Push the current one.
			//
			// Context only — not the primary mode. Mode is the analyst's last
			// explicit choice for *this* target and is persisted; retroactively
			// flipping it to reading on the way back in would change a view
			// while they were not looking, which `principles.md` §5 forbids.
			this.updateSurfaceContext();
		}
	}

	override focus(): void {
		this.primary.focus();
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.functionsRefresh.clear();
		this.targetPath = undefined;
		this.session = undefined;
		this.functions = [];
		this.navigator.setZoneVisible(false);
		this.primary.setZoneVisible(false);
		this.inspector.setZoneVisible(false);
		super.clearInput();
	}

	/**
	 * Offers to open a segment as its own editor tab.
	 *
	 * Tear-off is what makes comparison work — freeze one function in a tab,
	 * keep navigating in the workspace (`principles.md` §5) — but a capability
	 * with no affordance is a capability nobody uses, and right-click on the
	 * thing itself is where an analyst looks first. Only surfaces that declare
	 * `tearOff` and can produce an input for the current context offer it.
	 */
	private showSegmentContextMenu(id: string, anchor: HTMLElement): void {
		const descriptor = allDelverSurfaces().find(surface => surface.id === id);
		const context = this.surfaceContext();
		if (!descriptor?.tearOff || !context) {
			return;
		}
		const input = descriptor.tearOff(context);
		if (!input) {
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [toAction({
				id: 'delver.workspace.tearOffSurface',
				label: localize('delverTearOffSurface', "Open in Editor"),
				run: () => {
					void this.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
				},
			})],
		});
	}

	private surfaceContext(): IDelverSurfaceContext | undefined {
		const targetPath = this.targetPath;
		const session = this.session;
		if (!targetPath || !session) {
			return undefined;
		}
		const focus = this.focusService.focus;
		const location = focus.location;
		const functionRva = location?.space === 'Image'
			? containingFunctionRva(this.functions, location.address)
			: undefined;
		const functionName = functionRva === undefined ? undefined : this.interpretationService.nameAt({
			kind: 'image',
			contentHash: session.contentHash,
			rva: functionRva,
		});
		return { targetPath, focus, functionRva, functionName };
	}

	/** Offers one toggle per zone, refusing to hide the last visible one. */
	private showZoneMenu(anchor: HTMLElement): void {
		const state = this.state;
		if (!state) {
			return;
		}
		const zones: readonly [string, keyof IDelverWorkspaceState & `${string}Visible`][] = [
			[localize('delverZoneNavigator', "Navigator"), 'navigatorVisible'],
			[localize('delverZonePrimary', "Primary"), 'primaryVisible'],
			[localize('delverZoneInspector', "Inspector"), 'inspectorVisible'],
		];
		const shown = zones.filter(([, key]) => state[key]).length;
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => zones.map(([label, key]) => toAction({
				id: `delver.workspace.toggleZone.${key}`,
				label,
				checked: state[key] === true,
				// The last visible zone cannot be hidden: an empty workspace has
				// no affordance left to bring anything back.
				enabled: state[key] !== true || shown > 1,
				run: () => this.setZoneVisible(key, !state[key]),
			})),
		});
	}

	private setZoneVisible(key: 'navigatorVisible' | 'primaryVisible' | 'inspectorVisible', visible: boolean): void {
		if (!this.state) {
			return;
		}
		this.state = { ...this.state, [key]: visible };
		this.applyZoneVisibility();
		this.persistWorkspaceState();
	}

	private applyZoneVisibility(): void {
		const state = this.state;
		if (!state) {
			return;
		}
		this.splitView.setViewVisible(0, state.navigatorVisible);
		this.splitView.setViewVisible(1, state.primaryVisible);
		this.splitView.setViewVisible(2, state.inspectorVisible);
	}

	private refreshDescriptors(): void {
		const all = allDelverSurfaces();
		const matches = (expression: Parameters<IContextKeyService['contextMatchesRules']>[0]) => this.contextKeyService.contextMatchesRules(expression);
		this.navigator.setDescriptors(surfacesForZone(all, DelverZone.Navigator, matches));
		this.primary.setDescriptors(surfacesForZone(all, DelverZone.Primary, matches));
		this.inspector.setDescriptors(surfacesForZone(all, DelverZone.Inspector, matches));
	}

	private applyVisibleState(): void {
		const state = this.state;
		if (!state) {
			return;
		}
		this.navigator.show([state.navigatorSurfaceId]);
		this.inspector.show([state.inspectorSurfaceId]);
		this.primary.show([state.primarySurfaceId]);
		this.navigator.setZoneVisible(this.editorVisible);
		this.primary.setZoneVisible(this.editorVisible);
		this.inspector.setZoneVisible(this.editorVisible);
		this.applyZoneVisibility();
	}

	private selectNavigator(id: string): void {
		if (!this.state) {
			return;
		}
		this.state = { ...this.state, navigatorSurfaceId: id };
		this.navigator.show([id]);
		this.persistWorkspaceState();
	}

	private selectInspector(id: string): void {
		if (!this.state) {
			return;
		}
		this.state = { ...this.state, inspectorSurfaceId: id };
		this.inspector.show([id]);
		this.persistWorkspaceState();
	}

	private showRequestedSurface(id: string): void {
		switch (zoneForSurface(allDelverSurfaces(), id)) {
			case DelverZone.Navigator: this.selectNavigator(id); break;
			case DelverZone.Inspector: this.selectInspector(id); break;
			case DelverZone.Primary: this.selectPrimary(id); break;
		}
	}

	private selectPrimary(id: string): void {
		if (!this.state) {
			return;
		}
		this.state = { ...this.state, primarySurfaceId: id };
		this.primary.show([id]);
		this.updateSurfaceContext();
		this.persistWorkspaceState();
	}

	private async refreshFunctions(token: CancellationToken): Promise<void> {
		try {
			const result = await this.sessionService.functions();
			if (!token.isCancellationRequested) {
				this.functions = result.functions;
			}
		} catch {
			// A superseded refresh must not clear a good list. `functions` feeds
			// `containingFunctionRva`, so emptying it here would silently tell
			// Pseudocode that no function contains the cursor.
			if (!token.isCancellationRequested) {
				this.functions = [];
			}
		}
	}

	private updateSurfaceContext(): void {
		const surfaceContext = this.surfaceContext();
		if (!surfaceContext) {
			return;
		}
		this.navigator.setContext(surfaceContext);
		this.primary.setContext(surfaceContext);
		this.inspector.setContext(surfaceContext);
	}

	private updateHeader(): void {
		const session = this.session;
		if (!session) {
			return;
		}
		this.targetMetadata.textContent = session.image
			? localize(
				'delverWorkspaceTargetMetadata',
				"{0} · {1} functions · {2} instructions · analyzed",
				session.image.arch,
				session.image.function_count,
				session.image.instruction_count,
			)
			: localize('delverWorkspaceOfflineMetadata', "Saved project · target not attached");
	}

	private saveWidths(): void {
		if (!this.state || !this.targetPath || this.restoreWidths) {
			return;
		}
		this.state = {
			...this.state,
			navigatorWidth: this.splitView.getViewSize(0),
			inspectorWidth: this.splitView.getViewSize(2),
		};
		this.persistWorkspaceState();
	}

	private savePrimarySplitRatio(ratio: number): void {
		if (!this.state || !this.targetPath) {
			return;
		}
		this.state = { ...this.state, primarySplitRatio: ratio };
		this.persistWorkspaceState();
	}

	private persistWorkspaceState(): void {
		if (this.state && this.targetPath) {
			this.stateStore.save(this.targetPath, this.state);
		}
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
