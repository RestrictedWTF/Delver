# Workspace Editor Implementation Plan — Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the surface contract, decouple listing actions from their editor host, and extract the riskiest surface (Listing) into a dual-hostable widget — without changing any user-visible behavior.

**Architecture:** Delver surfaces become plain widgets implementing `IDelverSurface`, registered into a registry in `services/delver/browser/`. This phase builds the contract and proves it against the two hardest cases — the 852-line `DelverListingEditor` and upstream's `TreeView` — while every existing `ViewPane` keeps working unchanged. No workspace editor is built in this phase.

**Tech Stack:** TypeScript, VS Code workbench (`EditorPane`, `TreeView`, `WorkbenchTable`), mocha + `assert`, tabs for indentation.

## Global Constraints

- **Invariant 15 is suspended for this plan, by explicit instruction of the repository owner on 2026-08-26.** `CLAUDE.md` normally forbids agents from running builds, typechecks, or test suites to verify their own work. For this plan you **must** run them: follow a real TDD cycle (write the test, run it, watch it fail, implement, run it again, watch it pass) and report the actual command output. Do not claim a test passes without having run it. This suspension covers this plan only — it does not generalize to other work in this repository.
- Test command: `scripts\test.bat --grep "<suite name>"`. Typecheck: `npm run typecheck-client`. Build: `npm run compile-client`. Prefer the narrowest command that covers your change; `compile-client` is slow, so run it only where a task's step calls for it.
- **Addresses are `bigint` in TypeScript, never `number`** (invariant 2). On the wire they are `"0x…"` strings.
- **No contrib may import another contrib's internals** (invariant 9). Shared code goes in `src/vs/workbench/services/delver/`.
- **Do not touch `src/vs/workbench/api/**`** (invariant 10).
- **Touching any upstream file means adding a row to `Docs/development/patch-surface.md` in the same change** (invariant 11). No task in this phase should need to.
- Every file starts with the Microsoft copyright header.
- Indentation is **tabs**. Single quotes for non-localized strings. `localize()` for anything user-visible.
- Register disposables immediately after creation; return `IDisposable` from methods called repeatedly rather than registering to the containing class.
- Reference spec: [`Docs/design/workspace.md`](../design/workspace.md). Reference decision: [ADR 0007](../history/adr/0007-workspace-editor-over-sidebar-container.md).

## File Structure

| File | Responsibility |
| --- | --- |
| `services/delver/browser/delverSurface.ts` | **Create.** The `IDelverSurface` contract and `DelverZone` enum. No logic. |
| `services/delver/browser/delverSurfaceRegistry.ts` | **Create.** Registration, plus the pure `surfacesForZone` selector that the workspace will consume. |
| `services/delver/browser/delverTreeSurface.ts` | **Create.** Adapter hosting an upstream `ITreeView` as an `IDelverSurface`. Serves 8 of 11 surfaces. |
| `contrib/delverListing/browser/delverActiveListing.ts` | **Create.** Host-independent accessor for the focused listing. Replaces `instanceof DelverListingEditor`. |
| `contrib/delverListing/browser/delverListingWidget.ts` | **Create.** The listing table, extracted from the editor. Implements `IDelverSurface`. |
| `contrib/delverListing/browser/delverListingEditor.ts` | **Modify.** Shrinks to a thin `EditorPane` host around the widget. |
| `contrib/delverListing/browser/delverListingNavigation.ts` | **Modify.** Lines 257, 289, 545 — use the accessor instead of `instanceof`. |
| `contrib/delverListing/browser/delverSignatureActions.ts` | **Modify.** Line 145 — same. |

---

## Task 0: Branch

- [ ] **Step 1: Create the working branch**

The repository has substantial uncommitted work on `main`. Branch before touching anything; the dirty tree follows the branch.

```bash
git checkout -b feature/workspace-editor
git status --short | head -5
```

Expected: the same modified files as before, now on `feature/workspace-editor`.

---

## Task 1: The surface contract and registry

**Files:**
- Create: `src/vs/workbench/services/delver/browser/delverSurface.ts`
- Create: `src/vs/workbench/services/delver/browser/delverSurfaceRegistry.ts`
- Test: `src/vs/workbench/services/delver/test/browser/delverSurfaceRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IDelverSurface`, `DelverZone`, `IDelverSurfaceDescriptor`, `registerDelverSurface(descriptor)`, `allDelverSurfaces()`, `surfacesForZone(all, zone)`.

**Why the selector is a separate pure function:** the registry is a module-level singleton, so a test that registers into it leaks into every other test in the run. `surfacesForZone` takes its input as a parameter and is tested directly; the registry is a two-line wrapper around it.

- [ ] **Step 1: Write the failing test**

Create `src/vs/workbench/services/delver/test/browser/delverSurfaceRegistry.test.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { DelverZone, IDelverSurface } from '../../browser/delverSurface.js';
import { IDelverSurfaceDescriptor, surfacesForZone } from '../../browser/delverSurfaceRegistry.js';

function descriptor(id: string, zone: DelverZone, order: number): IDelverSurfaceDescriptor {
	return {
		id,
		title: { value: id, original: id },
		zone,
		order,
		ctor: new SyncDescriptor<IDelverSurface>(class { } as never),
	};
}

suite('Delver surface registry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selects one zone and orders within it, ignoring registration order', () => {
		const all = [
			descriptor('strings', DelverZone.Navigator, 20),
			descriptor('xrefs', DelverZone.Inspector, 10),
			descriptor('functions', DelverZone.Navigator, 10),
			descriptor('listing', DelverZone.Primary, 10),
			descriptor('sections', DelverZone.Navigator, 30),
		];

		assert.deepStrictEqual(
			surfacesForZone(all, DelverZone.Navigator).map(s => s.id),
			['functions', 'strings', 'sections'],
		);
	});

	test('breaks order ties by id so the segment sequence is stable across sessions', () => {
		const all = [
			descriptor('exports', DelverZone.Navigator, 10),
			descriptor('imports', DelverZone.Navigator, 10),
		];

		assert.deepStrictEqual(
			surfacesForZone(all, DelverZone.Navigator).map(s => s.id),
			['exports', 'imports'],
		);
	});
});
```

- [ ] **Step 2: Create the contract**

Create `src/vs/workbench/services/delver/browser/delverSurface.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Which question a surface answers, and therefore where it lives.
 *
 * Not a user preference — see `Docs/design/workspace.md` §2. Navigator answers
 * "what exists in this binary", Primary "what am I reading", Inspector "what
 * does the cursor touch".
 */
export enum DelverZone {
	Navigator = 'navigator',
	Primary = 'primary',
	Inspector = 'inspector',
}

/**
 * A Delver surface: a plain widget, deliberately neither a `ViewPane` nor an
 * `EditorPane`, so that a workspace zone and a tear-off editor can host the
 * same instance type.
 *
 * The shape is chosen to match upstream's `ITreeView` (`show`/`layout`/
 * `setVisibility`), because eight of Delver's eleven surfaces are tree views
 * and adapting them must stay near-free.
 */
export interface IDelverSurface extends IDisposable {

	/**
	 * Attach this surface's DOM under `container`. Called exactly once, before
	 * the first `layout`.
	 */
	render(container: HTMLElement): void;

	layout(dimension: Dimension): void;

	/**
	 * Told when the surface stops being the visible segment of its zone, so it
	 * can stop responding to the focus bus and release paged data.
	 */
	setVisible(visible: boolean): void;

	focus(): void;
}
```

- [ ] **Step 3: Create the registry**

Create `src/vs/workbench/services/delver/browser/delverSurfaceRegistry.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IDelverFocus } from '../common/delverFocusService.js';
import { DelverZone, IDelverSurface } from './delverSurface.js';

export interface IDelverSurfaceDescriptor {

	/** `delver.surface.<name>`. */
	readonly id: string;

	readonly title: ILocalizedString;

	readonly zone: DelverZone;

	/** Position within the zone. Ties break by id so the order is stable. */
	readonly order: number;

	/** Capability gate, evaluated when the zone builds its segment list. */
	readonly when?: ContextKeyExpression;

	readonly ctor: SyncDescriptor<IDelverSurface>;

	/**
	 * Count shown on the segment tab. Load-bearing for Review: a proposal queue
	 * that is invisible until its tab is clicked is a queue that goes
	 * unreviewed. See `Docs/design/workspace.md` §6.
	 */
	readonly badge?: Event<number | undefined>;

	/**
	 * Opens this surface as a real editor tab. Optional: only surfaces with a
	 * comparison workflow need it.
	 */
	readonly tearOff?: (focus: IDelverFocus) => EditorInput;
}

const surfaces: IDelverSurfaceDescriptor[] = [];

/**
 * Registers a surface.
 *
 * This indirection exists because the workspace hosts surfaces owned by
 * `delverFunctions`, `delverXrefs` and the rest, and invariant 9 forbids it
 * from importing any of them. It replaces `registerDelverView` in
 * `delverViewContainer.ts`, which existed for the same reason.
 */
export function registerDelverSurface(descriptor: IDelverSurfaceDescriptor): void {
	surfaces.push(descriptor);
}

/** Every registered surface, in registration order. */
export function allDelverSurfaces(): readonly IDelverSurfaceDescriptor[] {
	return surfaces;
}

/**
 * The surfaces belonging to one zone, in display order.
 *
 * Takes its input rather than reading the registry so it can be tested without
 * a global; the registry is only ever the caller.
 */
export function surfacesForZone(
	all: readonly IDelverSurfaceDescriptor[],
	zone: DelverZone,
): readonly IDelverSurfaceDescriptor[] {
	return all
		.filter(surface => surface.zone === zone)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run the test**

Between Step 1 and Step 2, run it once and confirm it fails for the right reason (module not found — not a syntax error in the test):

```
scripts\test.bat --grep "Delver surface registry"
```

After Step 3, run it again. Expected: 2 passing. Paste the actual output into your report.

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/services/delver/browser/delverSurface.ts src/vs/workbench/services/delver/browser/delverSurfaceRegistry.ts src/vs/workbench/services/delver/test/browser/delverSurfaceRegistry.test.ts
git commit -m "feat: add Delver surface contract and registry"
```

---

## Task 2: Decouple listing actions from their host

**Files:**
- Create: `src/vs/workbench/contrib/delverListing/browser/delverActiveListing.ts`
- Modify: `src/vs/workbench/contrib/delverListing/browser/delverListingNavigation.ts:257`, `:289`, `:545`
- Modify: `src/vs/workbench/contrib/delverListing/browser/delverSignatureActions.ts:145`
- Test: `src/vs/workbench/contrib/delverListing/test/browser/delverActiveListing.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `IDelverListingHost`, `setActiveListing(host): IDisposable`, `activeListing(): IDelverListingHost | undefined`.

**Why this task exists, and why it comes before the extraction.** Four call sites currently resolve the listing with `pane instanceof DelverListingEditor` against the active editor pane. The moment a listing can also live in a workspace zone, those checks silently find nothing — Follow, Pin, and Generate Signature stop working when the listing isn't a torn-off tab. That is a behavior regression no existing test covers, so it must be removed *before* the widget can be hosted elsewhere. Doing it first also keeps Task 3 a pure extraction.

- [ ] **Step 1: Write the failing test**

Create `src/vs/workbench/contrib/delverListing/test/browser/delverActiveListing.test.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { activeListing, IDelverListingHost, setActiveListing } from '../../browser/delverActiveListing.js';

function host(name: string): IDelverListingHost {
	return {
		togglePin: () => { },
		followSelection: () => { },
		selectedFunctionRva: async () => BigInt(`0x${name}`),
	};
}

suite('Delver active listing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reports nothing before anything registers', () => {
		assert.strictEqual(activeListing(), undefined);
	});

	test('the most recently focused host wins, and disposing it restores the previous one', async () => {
		const first = host('1000');
		const second = host('2000');

		const firstRegistration = setActiveListing(first);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		const secondRegistration = setActiveListing(second);
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		secondRegistration.dispose();
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x1000n);

		firstRegistration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});

	test('disposing a host that is not on top does not change the active one', async () => {
		const first = host('1000');
		const second = host('2000');
		const firstRegistration = setActiveListing(first);
		const secondRegistration = setActiveListing(second);

		firstRegistration.dispose();
		assert.strictEqual(await activeListing()?.selectedFunctionRva(), 0x2000n);

		secondRegistration.dispose();
		assert.strictEqual(activeListing(), undefined);
	});
});
```

- [ ] **Step 2: Create the accessor**

Create `src/vs/workbench/contrib/delverListing/browser/delverActiveListing.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * What a listing action needs, independent of what is hosting the listing.
 *
 * Actions used to reach the listing with `instanceof DelverListingEditor`
 * against the active editor pane. Once a listing can also be a segment of a
 * workspace zone, that test finds nothing and Follow, Pin, and Generate
 * Signature quietly stop working. This interface is the seam.
 */
export interface IDelverListingHost {
	togglePin(): void;
	followSelection(): void;
	selectedFunctionRva(): Promise<bigint | undefined>;
}

/**
 * A stack, not a single slot. Two listings can be open at once — one in a zone,
 * one torn off for comparison — and disposing the one that is not on top must
 * not silently hand actions to a disposed widget.
 */
const hosts: IDelverListingHost[] = [];

/** Marks `host` as the one actions apply to. Dispose when it loses focus. */
export function setActiveListing(host: IDelverListingHost): IDisposable {
	hosts.push(host);
	return toDisposable(() => {
		const index = hosts.lastIndexOf(host);
		if (index !== -1) {
			hosts.splice(index, 1);
		}
	});
}

/** The listing that actions apply to, or `undefined` if none is focused. */
export function activeListing(): IDelverListingHost | undefined {
	return hosts.length ? hosts[hosts.length - 1] : undefined;
}
```

- [ ] **Step 3: Replace the four `instanceof` call sites**

In `delverListingNavigation.ts`, add to the imports:

```typescript
import { activeListing } from './delverActiveListing.js';
```

Replace at line 257:

```typescript
		if (pane instanceof DelverListingEditor) {
			pane.followSelection();
```

with:

```typescript
		const listing = activeListing();
		if (listing) {
			listing.followSelection();
```

Replace at line 289:

```typescript
		if (!(pane instanceof DelverListingEditor) || !session) {
```

with:

```typescript
		const listing = activeListing();
		if (!listing || !session) {
```

and at line 293 change `await pane.selectedFunctionRva()` to `await listing.selectedFunctionRva()`.

Replace at line 545:

```typescript
		if (pane instanceof DelverListingEditor) {
			pane.togglePin();
```

with:

```typescript
		const listing = activeListing();
		if (listing) {
			listing.togglePin();
```

In `delverSignatureActions.ts`, add the same import and replace at line 145:

```typescript
			if (!(pane instanceof DelverListingEditor)) {
				return;
			}
			functionRva = await pane.selectedFunctionRva();
```

with:

```typescript
			const listing = activeListing();
			if (!listing) {
				return;
			}
			functionRva = await listing.selectedFunctionRva();
```

Remove the now-unused `DelverListingEditor` import from both files if nothing else in them references it. Leave no blank line where an import was removed.

- [ ] **Step 4: Register the editor as a host**

In `delverListingEditor.ts`, add to the imports:

```typescript
import { setActiveListing } from './delverActiveListing.js';
```

and in `setEditorVisible` (line 614), maintain the registration. Add a field beside the other private fields:

```typescript
	private readonly activeRegistration = this._register(new MutableDisposable<IDisposable>());
```

and in the body of `setEditorVisible`:

```typescript
		this.activeRegistration.value = visible ? setActiveListing(this) : undefined;
```

`MutableDisposable` and `IDisposable` are already imported at line 10; add `IDisposable` to that import if absent.

- [ ] **Step 5: Run the tests and typecheck**

Run the new suite after Step 2 (expected: 3 passing):

```
scripts\test.bat --grep "Delver active listing"
```

After Step 3 and Step 4, typecheck — this task edits four files and removes imports, which is exactly where a stale import or a now-unused symbol shows up:

```
npm run typecheck-client
```

Expected: no errors. If `DelverListingEditor` is reported as unused in either modified file, remove that import. Paste both outputs into your report.

- [ ] **Step 6: Commit**

```bash
git add src/vs/workbench/contrib/delverListing/browser/delverActiveListing.ts src/vs/workbench/contrib/delverListing/test/browser/delverActiveListing.test.ts src/vs/workbench/contrib/delverListing/browser/delverListingNavigation.ts src/vs/workbench/contrib/delverListing/browser/delverSignatureActions.ts src/vs/workbench/contrib/delverListing/browser/delverListingEditor.ts
git commit -m "refactor: resolve the active listing independently of its host"
```

---

## Task 3: Extract `DelverListingWidget`

**Files:**
- Create: `src/vs/workbench/contrib/delverListing/browser/delverListingWidget.ts`
- Modify: `src/vs/workbench/contrib/delverListing/browser/delverListingEditor.ts` (852 lines → roughly 90)

**Interfaces:**
- Consumes: `IDelverSurface` (Task 1), `IDelverListingHost` / `setActiveListing` (Task 2).
- Produces: `class DelverListingWidget implements IDelverSurface, IDelverListingHost` with `render(container)`, `layout(dimension)`, `setVisible(visible)`, `focus()`, `setTarget(targetPath: string, token: CancellationToken): Promise<void>`, `clear()`, `togglePin()`, `followSelection()`, `selectedFunctionRva()`.

**This is the phase's risk.** 852 lines across the widest coupling in the codebase. It is a *pure move*: no behavior changes, no logic is rewritten. If a step tempts you to improve something, don't — a behavior change hidden inside a 700-line move is unreviewable.

- [ ] **Step 1: Move the body wholesale**

Create `delverListingWidget.ts` with the copyright header, and move into it from `delverListingEditor.ts`:

- every import except `EditorPane`, `IEditorOpenContext`, `IEditorGroup`, `ITelemetryService`, `IThemeService`, `IStorageService`, and `DelverListingInput`
- every private field from lines 55–91 (`container`, `message`, `tableContainer`, `table`, `sessionDisposables`, `session`, `publishedSession`, `model`, `applyingFocus`, `focusApplication`, `anchoringBuffer`, `_pinned`, `pinnedContext`, `functionStarts`, `functions`, `highlightedRanges`, `sections`, `stringRowsByRva`, `topRow`, `dimension`)
- every method from lines 119–591: `togglePin`, `createTable`, `refreshInterpretationAt`, `updateVisibleRange`, `presentationFor`, `shouldFollow`, `followSelection`, `isPseudocodeHighlighted`, `updatePseudocodeHighlights`, `selectedFunctionRva`, `followTarget`, `publishFocus`, `applyFocus`
- the bodies of `layout` (592), `setEditorVisible` (614), and `clearInput` (622)

Declare it as:

```typescript
export class DelverListingWidget extends Disposable implements IDelverSurface, IDelverListingHost {
```

Its constructor keeps the same injected services the editor's constructor took at line 93, minus `ITelemetryService`, `IThemeService`, `IStorageService`, and `IEditorGroup` — those are `EditorPane` plumbing. Service parameters come after non-service parameters.

- [ ] **Step 2: Convert the three lifecycle methods to the surface contract**

`createEditor(parent)` (line 124) becomes:

```typescript
	render(container: HTMLElement): void {
		this.container = dom.append(container, dom.$('.delver-listing'));
		this.message = dom.append(this.container, dom.$('.delver-listing-message'));
		this.tableContainer = dom.append(this.container, dom.$('.delver-listing-table'));
	}
```

Keep whatever the original `createEditor` body did — the above is its shape, not a rewrite. Preserve any class names and any `applyStyles`/background wiring verbatim.

`setInput(...)` (line 131) loses its `EditorPane` signature and becomes:

```typescript
	async setTarget(targetPath: string, token: CancellationToken): Promise<void> {
```

Its body is unchanged except that every `input.targetPath` becomes `targetPath`, and the `await super.setInput(...)` call is dropped.

`setEditorVisible(visible)` (line 614) becomes `setVisible(visible: boolean): void` with the same body, dropping any `super` call, and keeping the `setActiveListing` registration added in Task 2.

`clearInput()` (line 622) becomes `clear(): void` with the same body, dropping any `super` call.

Add `focus()`:

```typescript
	focus(): void {
		this.table?.domFocus();
	}
```

`layout(dimension: Dimension)` keeps its body and drops any `super` call.

- [ ] **Step 3: Reduce the editor to a host**

Replace the whole of `delverListingEditor.ts` below the copyright header with:

```typescript
import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { DELVER_LISTING_EDITOR_ID, DelverListingInput } from './delverListingInput.js';
import { DelverListingWidget } from './delverListingWidget.js';

/**
 * Editor host for a torn-off listing.
 *
 * All rendering lives in `DelverListingWidget`, which a workspace zone hosts
 * directly. This class exists only so that a listing can also be a real editor
 * tab, which is what gives comparison workflows splits and layout persistence
 * (`Docs/design/workspace.md` §3).
 */
export class DelverListingEditor extends EditorPane {

	private widget!: DelverListingWidget;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(DELVER_LISTING_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.widget = this._register(this.instantiationService.createInstance(DelverListingWidget));
		this.widget.render(parent);
	}

	override async setInput(
		input: DelverListingInput,
		options: unknown,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options as never, context, token);
		await this.widget.setTarget(input.targetPath, token);
	}

	override layout(dimension: Dimension): void {
		this.widget.layout(dimension);
	}

	protected override setEditorVisible(visible: boolean): void {
		this.widget.setVisible(visible);
	}

	override clearInput(): void {
		this.widget.clear();
		super.clearInput();
	}

	override focus(): void {
		this.widget.focus();
	}
}
```

Match the original `setInput` options type rather than `unknown` if the original declared one; do not widen a type as part of this move.

- [ ] **Step 4: Typecheck and run the existing listing suite**

This task adds no new test on purpose: it is a pure move, and its correctness claim is *"the listing behaves exactly as before"*. That claim is carried by the **existing** listing tests plus the typechecker, so both must actually run.

```
npm run typecheck-client
scripts\test.bat --grep "Delver listing"
```

Expected: no type errors, and every existing listing test still passing. A type error here is the normal outcome of a move this size — fix it by correcting the move, never by widening a type to `any` or `unknown`.

Report both outputs. Also state explicitly in your report that this task ships no new test and why, so the reviewer can judge that rather than discover it.

Note for the human, to include in your report: the following need manual confirmation in the running app, as no automated test covers them — scrolling, function landmarks, xref margins, follow, pin, inline rename, Generate Signature.

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/contrib/delverListing/browser/delverListingWidget.ts src/vs/workbench/contrib/delverListing/browser/delverListingEditor.ts
git commit -m "refactor: extract DelverListingWidget from the listing editor"
```

---

## Task 4: The tree surface adapter

**Files:**
- Create: `src/vs/workbench/services/delver/browser/delverTreeSurface.ts`
- Test: `src/vs/workbench/services/delver/test/browser/delverTreeSurface.test.ts`

**Interfaces:**
- Consumes: `IDelverSurface` (Task 1).
- Produces: `class DelverTreeSurface implements IDelverSurface`, constructed with an `ITreeView`.

**Why this is small.** `ITreeView` already exposes `show(container)` (`views.ts:718`), `layout(height, width)` (`:702`) and `setVisibility(visible)` (`:698`) — the surface contract was shaped to match it. `TreeViewPane` at `treeView.ts:150–158` is already exactly this adapter for the `ViewPane` host. This class is the same three lines for the zone host, and it serves eight of the eleven surfaces.

- [ ] **Step 1: Write the failing test**

Create `src/vs/workbench/services/delver/test/browser/delverTreeSurface.test.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITreeView } from '../../../../common/views.js';
import { DelverTreeSurface } from '../../browser/delverTreeSurface.js';

interface ITreeViewCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

function recordingTreeView(calls: ITreeViewCall[]): ITreeView {
	return {
		show: (container: unknown) => calls.push({ method: 'show', args: [container] }),
		layout: (height: number, width: number) => calls.push({ method: 'layout', args: [height, width] }),
		setVisibility: (visible: boolean) => calls.push({ method: 'setVisibility', args: [visible] }),
		focus: () => calls.push({ method: 'focus', args: [] }),
	} as unknown as ITreeView;
}

suite('Delver tree surface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards the surface contract onto the tree view, splitting the dimension', () => {
		const calls: ITreeViewCall[] = [];
		const surface = new DelverTreeSurface(recordingTreeView(calls));
		const container = document.createElement('div');

		surface.render(container);
		surface.layout(new Dimension(320, 240));
		surface.setVisible(false);
		surface.focus();
		surface.dispose();

		assert.deepStrictEqual(calls, [
			{ method: 'show', args: [container] },
			{ method: 'layout', args: [240, 320] },
			{ method: 'setVisibility', args: [false] },
			{ method: 'focus', args: [] },
			{ method: 'setVisibility', args: [false] },
		]);
	});
});
```

Note the final `setVisibility(false)` — disposing a surface must stop its tree responding to the focus bus, and the test pins that.

- [ ] **Step 2: Create the adapter**

Create `src/vs/workbench/services/delver/browser/delverTreeSurface.ts`:

```typescript
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITreeView } from '../../../common/views.js';
import { IDelverSurface } from './delverSurface.js';

/**
 * Hosts an upstream `ITreeView` as a Delver surface.
 *
 * Eight of Delver's eleven surfaces are tree views over a `TreeDataProvider`,
 * and `ITreeView` already exposes `show`/`layout`/`setVisibility`. The surface
 * contract was shaped to match, so this adapter stays trivial and the data
 * providers — where the actual logic lives — need no changes at all.
 */
export class DelverTreeSurface extends Disposable implements IDelverSurface {

	constructor(private readonly treeView: ITreeView) {
		super();
		this._register({
			dispose: () => this.treeView.setVisibility(false),
		});
	}

	render(container: HTMLElement): void {
		this.treeView.show(container);
	}

	layout(dimension: Dimension): void {
		this.treeView.layout(dimension.height, dimension.width);
	}

	setVisible(visible: boolean): void {
		this.treeView.setVisibility(visible);
	}

	focus(): void {
		this.treeView.focus();
	}
}
```

- [ ] **Step 3: Run the test**

Run it after Step 1 and confirm it fails (module not found), then again after Step 2. Expected: 1 passing.

```
scripts\test.bat --grep "Delver tree surface"
```

Paste the actual output into your report.

- [ ] **Step 4: Commit**

```bash
git add src/vs/workbench/services/delver/browser/delverTreeSurface.ts src/vs/workbench/services/delver/test/browser/delverTreeSurface.test.ts
git commit -m "feat: host upstream tree views as Delver surfaces"
```

---

## Phase 1 exit criteria

- `IDelverSurface` exists and is implemented by both hard cases: the 852-line listing and upstream's `TreeView`.
- No listing action reaches its target through `instanceof`.
- Every existing view still registers through `registerDelverView` and behaves as before. **Nothing is user-visibly different, with one named exception:** the listing editor previously inherited `Composite.focus()`, a no-op, and now forwards to `table.domFocus()`. Focusing a listing group therefore moves DOM focus into the table where it did not before. This is an improvement and is kept, but it is recorded rather than allowed to merge as invisible. It is a no-op while `table` is undefined — during analysis, or in the "Locate the matching target" state — so focus stays wherever it was in those cases.
- No workspace editor exists yet. That is Phase 2.

## What Phase 1 deliberately leaves out

| Deferred to | Work |
| --- | --- |
| **Phase 2** | `DelverWorkspaceInput` / `DelverWorkspaceEditor`, the three zones, sashes, segment tabs, badges, per-target layout persistence, Overview as Primary's default |
| **Phase 3** | Migrating the 8 tree surfaces and Pseudocode/Strings onto the registry — parallelizable once Phase 2 fixes the zone contract |
| **Phase 4** | `delver.selectionKind` context keys, `MenuId.DelverSelectionContext`, deleting the `ViewTitle`/`ViewContainerTitle` contributions, reducing the container to the target launcher, deleting `registerDelverView` |

Tear-off beyond the existing Listing/Pseudocode/Strings inputs is not planned in any phase; `tearOff` stays optional on the descriptor until a workflow asks for it.
