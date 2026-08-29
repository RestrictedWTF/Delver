# The Workspace

**The container surface.** Every other surface spec in this folder describes
something that lives *inside* this one, so this doc settles the questions they
would otherwise each answer differently: where a surface appears, what owns its
height, and where its actions live.

Supersedes the sidebar view-container arrangement built through P1–P3. The
decision to move is recorded in
[ADR 0007](../history/adr/0007-workspace-editor-over-sidebar-container.md).

---

## 1. What went wrong with the sidebar

Worth stating plainly, because the failure was structural and the same forces
will rebuild it if only the symptoms are treated.

Eleven surfaces were registered as `ViewPane`s into one `ViewPaneContainer`
(`workbench.view.delver`). Three consequences followed, none of them a styling
problem:

**Every expanded pane held a claim on the same column of pixels.** VS Code
distributes a container's height across its expanded panes by weight. Opening a
surface therefore *shrinks* every other one, and closing it redistributes again.
Nothing an analyst arranged survived their next click. This is the "resizes
itself" complaint, and no amount of tuning fixes it while eleven peers share one
height budget.

**Peer surfaces were stacked as if they were a sequence.** Functions, Strings,
Imports, Exports and Sections answer the same question — *what is in this
binary?* — and an analyst consults exactly one at a time. Stacking them
vertically spends five headers and five scroll regions to show five slivers of
five lists, when the task only ever needed one full-height list.

**Actions bound to containers instead of to objects.** "Generate Signature"
acts on the selected function, but was contributed to `MenuId.ViewTitle`
(`delverSignatureActions.ts`), so it surfaced in whatever title bar happened to
be adjacent. Six more did the same through `MenuId.ViewContainerTitle`. An icon
whose subject isn't visible from where it sits reads as debris — correctly, since
nothing on screen connects it to what it operates on.

Density was the casualty of all three. [`principles.md`](principles.md) §2
argues that whitespace which reads as calm in a settings page reads as wasted
screen in a listing; the sidebar's defaults are tuned for the former.

## 2. Shape

A **workspace editor** — one `EditorInput` per open target, opening in the
editor area — divided into three zones with fixed roles.

```
┌ ⬡ sample.exe ┬ sub_401040 ─────────────────────────────────────────┐
│ sample.exe · PE32+ · x64 · 2.1 MB · analyzed        ◂ ▸    ⌕ 0x…   │
├──────────────┬──────────────────────────────┬──────────────────────┤
│ NAVIGATOR    │ PRIMARY              ◉ pin   │ INSPECTOR            │
│ Fn Str Imp   │ ┌ Listing ─┬─ Pseudocode ──┐ │ Xrefs  Sig  Review ⁷ │
│ Exp Sec      │ │ ▸ sub_401040            │ │                      │
│              │ │ 401040 push rbp         │ │ to sub_401040 · 3    │
│ 401000 start │ │ 401044 sub  rsp, 40h    │ │ 401234  call         │
│ 401040 sub_… │ │ 401048 lea  rcx, "cfg…" │ │ 4014a8  call         │
│ 4010e0 decr… │ │ 40104f call CreateFileA │ │ 4017f0  call         │
│ 401220 WinM… │ │ 401055 test rax, rax    │ │                      │
└──────────────┴──────────────────────────────┴──────────────────────┘
```

| Zone | Default width | Surfaces | Presentation |
| --- | --- | --- | --- |
| **Navigator** | 280px | Overview, Functions, Sections | segmented — one at a time, full height |
| **Primary** | flex | Listing (Pseudocode beside it), Strings, Imports, Exports | segmented; Listing shows two panes |
| **Inspector** | 280px | Xrefs, Signatures, Review | segmented, badged |

The zones are named for the question each answers. **Navigator: what exists in
this binary.** **Primary: what am I reading.** **Inspector: what does the
cursor touch.** A surface's zone follows from which question it answers, which
is why the assignment isn't a preference and isn't user-configurable — see §7.

### Height ownership

**Each zone is an independent flex column with its own scroll, and only the
sashes between zones move.** No two surfaces share a height budget, so no
surface can shrink another. That single property is the fix for §1's first
consequence, and it is the reason the zone model was chosen over a dock canvas.

Navigator surfaces become *segments of one zone* rather than stacked panes: one
full-height list, the rest as tabs. Segment switching does not resize anything.

### A zone can be hidden, but never rearranged

The three zones are fixed in **order and role**; each can be **hidden**. A menu
button in the header toggles them, and the choice persists per target beside the
zone widths.

Hiding is not the rearrangement §7 refuses. Rearrangement lets an analyst rebuild
§1's flooding by hand and breaks the guarantee that no surface can shrink
another; hiding removes a column and gives its width to the survivors, which
strengthens that guarantee. It answers the narrow, real case — reading a long
function on a laptop, where Navigator and Inspector are both cost.

**The last visible zone cannot be hidden.** An empty workspace is a state with no
affordance to leave it: nothing left to click, and the control that would undo it
lives in the header of a zone that is gone. The menu disables the final entry
rather than letting the workspace reach that state — the refusal in §7's spirit,
applied to a control the analyst does own.

### Overview is a Navigator segment

Overview answers *what is this binary* — the Navigator's question — so that is
where it lives. It was briefly Primary's default with a "home" affordance in the
header, which produced two controls doing one thing and filed a summary in the
zone reserved for what is being read.

Strings, Imports and Exports moved the other way, into Primary. They look like
indexes but they are **read**, not scanned past on the way somewhere else: an
analyst works through a string table the way they work through a function, and
at Navigator width their rows truncate.

### Listing and Pseudocode are one segment

They are always shown together — selecting either displayed both — so two tabs
advertised a choice that did not exist. Pseudocode is registered as a
**companion** of Listing: no tab of its own, never selectable alone, appearing
and disappearing with its host. The mechanism is general; the descriptor field
is `companions`.

### Listing spans the image, not the code

The Listing segment is one address-ordered sequence over the **whole image**:
instructions where code was decoded, strings where the scanner found them, in
address order. It used to be a block of instructions with the entire string
table appended after the last one, which meant a string reached from Strings
landed in that trailing block rather than at its address, and scrolling past the
last instruction fell off the end of the code.

The row space belongs to the analysis server, which owns the index that maps
row to address — the renderer never merges two sequences of its own. See
[ADR 0009](../history/adr/0009-unified-address-ordered-listing.md), which also
records what is still missing: undefined bytes have no rows, so the listing
still jumps over padding rather than showing `db` runs.

## 3. Surfaces are widgets, hosted twice

A surface is a plain widget, not a `ViewPane` and not an `EditorPane`:

```ts
interface IDelverSurface extends IDisposable {
	render(container: HTMLElement): void;
	layout(dimension: Dimension): void;
	setVisible(visible: boolean): void;
	focus(): void;
}
```

### Context binding belongs to the descriptor

The lifecycle contract above deliberately stays host-only. A surface descriptor
may additionally provide a typed `setContext(surface, context, token)` binding.
The workspace supplies the target path, current focus, and containing function;
the contribution that owns the surface decides which of those are meaningful.
Listing and Strings bind to the target, Pseudocode binds to the containing
function, and the tree-backed Navigator and Inspector surfaces continue to
follow the session and focus services directly.

This is the answer to the contract gap found after Phase 1. Adding a mandatory
`setTarget` to `IDelverSurface` would pretend that all three zones have the same
ownership model. Downcasting inside the workspace would instead make the host
depend on surface implementations. Descriptor-owned binding keeps the lifecycle
contract honest and preserves the contrib boundary: the host invokes an opaque
binding without knowing which widget it received.

Context updates are cancellable and latest-wins. Disposing a zone cancels its
binding before disposing the surface.

### Primary transition

Primary opens on Overview at full width. The first image-address focus switches
it to the reading layout: Listing and Pseudocode side by side, each with its own
height and scroll budget. Returning Home restores Overview. If the focused
address is not owned by a detected function, Listing still follows it and
Pseudocode says that no containing function is available; it never leaves stale
output from the previous function on screen.

Two hosts instantiate the same widget: the workspace zone, and a thin
`EditorPane` for **tear-off**. Tearing a surface off opens it as a real editor
tab, so splitting one listing against another still uses VS Code's editor
groups, history, and layout persistence rather than a reimplementation.

Listing, Pseudocode and Strings keep their existing `EditorInput`s
(`DelverListingInput`, `DelverPseudocodeInput`, `DelverStringsInput`) as
tear-off targets. Their current `EditorPane`s become thin hosts once the
rendering is extracted into a widget. Surfaces without an existing input — the
tree-backed ones — get tear-off only if a workflow asks for it; `tearOff` is
optional on the descriptor for exactly that reason.

Tear-off is what makes the comparison workflow in [`principles.md`](principles.md)
§5 work: freeze one function in a torn-off tab, navigate in the workspace.

## 4. Registration

Surfaces register into a registry in `services/delver/`, never into the
workspace contribution:

```ts
interface IDelverSurfaceDescriptor {
	readonly id: string;                          // delver.surface.functions
	readonly title: ILocalizedString;
	readonly zone: DelverZone;
	readonly order: number;
	readonly when?: ContextKeyExpression;
	readonly ctor: SyncDescriptor<IDelverSurface>;
	readonly setContext?: (surface: IDelverSurface, context: IDelverSurfaceContext, token: CancellationToken) => Promise<void> | void;
	readonly contextKey?: (context: IDelverSurfaceContext) => string;
	readonly badge?: Event<number | undefined>;
	readonly tearOff?: (context: IDelverSurfaceContext) => EditorInput | undefined;
}
```

Registration ids are unique. A second descriptor with the same id is rejected
immediately, at registration, because allowing both to survive would render two
indistinguishable segment tabs and move the failure away from its cause. The
registry exposes registration as a disposable operation so tests and dynamic
capability contributions do not leak module-global state.

This is required by invariant 9 — the workspace hosts surfaces owned by
`delverFunctions`, `delverXrefs` and the rest, and may not import any of them.
It mirrors the `registerDelverView` indirection already in
`delverViewContainer.ts`, which exists for exactly this reason and which this
registry replaces.

## 5. Actions bind to selection, not to containers

The zone name carries the product accent (`delver.zone.title`), the same hue as
the listing's function landmark. Zones are the frame an analyst orients by
before reading anything — like the landmark, not a kind of content but the
boundary between content (`principles.md` §3). Where width is tight the **zone
name yields before the segment names do**: a truncated segment is unusable,
because "S…" could be Strings or Sections, while a truncated zone name costs
nothing.

**Rule: a zone header may contain only view state — `pin` and `sync`. Nothing
else, ever.** This is enforceable and is meant to be enforced; it is the rule
whose absence produced §1's third consequence.

Every other action binds to the selected object:

- Context keys `delver.selectionKind` — one of `function`, `instruction`,
  `string`, `section`, `import`, `export`, `xref`, `proposal`, `none` — and
  `delver.selectionAddress`.
- One menu, `MenuId.DelverSelectionContext`, filtered per kind:
  `when: delver.selectionKind == 'function'`.
- Every action additionally carries a keybinding and a `Delver: …` command
  palette entry.

Actions surface **only** through the context menu, the keybinding, and the
palette. There is no persistent action chrome. "Generate Signature" then cannot
appear while a section is selected, because it is not an action on sections —
the misplacement of §1 becomes unrepresentable rather than merely discouraged.

This follows [`principles.md`](principles.md) §4: an analyst works at the
keyboard for hours, and chrome they don't click is chrome spending density they
do need.

**The cost, stated honestly:** discoverability drops. Nothing on screen
advertises that signature generation exists. Two mitigations are required, not
optional — the context menu shows each action's keybinding inline, and every
command is named with the `Delver:` prefix so palette search finds the whole
family at once. If usage shows features going unfound, the answer is a better
palette surface, not a toolbar.

## 6. The shell around it

The Delver view container survives with **exactly one view**: a target launcher
listing open targets, recents, and an Open Target button. Clicking a target
opens its workspace editor.

The container is kept for a specific reason. Activity-bar entries *are* view
containers upstream — `PaneCompositeBar` builds its items from
`viewDescriptorService.getViewContainers()`, and the only container-less
entries are the two hardcoded globals in `globalCompositeBar.ts`. Keeping the
icon without a container therefore means patching `activitybarPart.ts` and
`paneCompositeBar.ts`, both high-churn upstream files, and carrying two
**High**-risk rows in [`patch-surface.md`](../development/patch-surface.md)
against every rebase. One small view is much cheaper than that, and it is a
useful view rather than a stub: it is where multi-target investigation would
grow if that is ever wanted.

Elsewhere in the shell, nothing moves. Chat stays in the auxiliary bar — it is
upstream's surface, not ours. Findings continue to flow through
`IMarkerService` into Problems.

**Review** becomes an Inspector segment carrying a live count badge
(`Review · 7`). The badge is load-bearing: a proposal queue that is invisible
until you click its tab is a queue that goes unreviewed, and
[`ai-analyst.md`](../architecture/ai-analyst.md)'s governing constraint is that
an unauditable analyst is worse than none.

## 7. What this design deliberately refuses

**Drag-and-dock rearrangement.** Free arrangement is what allows §1's flooding
to be rebuilt by hand, and the zone model's guarantee — that no surface can
shrink another — cannot survive arbitrary nesting. Revisit only with evidence
that a specific workflow is blocked, and prefer moving a surface between zones
over a general dock canvas.

**Per-surface layout preferences.** Zone widths and the active segment persist
per target. Which zone a surface belongs to does not, because a surface's zone
is a claim about what question it answers.

**A parallel visual language.** [`README.md`](README.md) is unchanged here:
Delver inherits VS Code's tokens and component vocabulary. This surface is
custom in *layout*, not in look. Density inside data views resolves toward
[`principles.md`](principles.md) §2; workbench chrome stays as upstream draws it.

### Decompiler provenance belongs in the status bar

`principles.md` §1 requires provenance to stay visible, but a floating badge over
the pseudocode sat on the first lines of the function — the part most often
read. It is a status-bar entry instead: still always visible, never over the
code. It clears when the pane hides, so the analyst never reads provenance for
something they are no longer looking at.

## 8. Uncertainty

The workspace introduces no new uncertainty vocabulary. It inherits
[`principles.md`](principles.md) §1 and adds one obligation of its own: **a zone
must distinguish "no data" from "not yet loaded" from "this surface failed".**
Three zones now render concurrently against a paging analysis server, so a
blank Inspector during a slow xref query would otherwise read as "this function
has no callers" — a false negative delivered silently, which is the exact
failure §1 of the principles exists to prevent.

## 9. Keyboard

- Segment switching within the focused zone is bound; zones themselves are
  reachable without the mouse.
- `pin` and `sync` are bound and visible without hover, per
  [`principles.md`](principles.md) §5.
- Address history remains `IDelverFocusService.back()` / `forward()`, unchanged
  and already implemented. This is what makes the move affordable: the
  address-history dividend that [`ide-architecture.md`](../architecture/ide-architecture.md)
  §2 credited to editor history is in fact owned by the focus bus, so hosting
  the listing in a zone costs nothing there.

## 10. Migration

Staged so the build is never broken. All six landed:

1. ✅ Extract surface widgets out of the existing `ViewPane`s,
   behavior-preserving. Views kept working throughout.
2. ✅ Add the surface registry alongside `registerDelverView`.
3. ✅ Build the workspace editor and zones; register surfaces into it.
4. ✅ Move actions to selection-scoped menus; delete the `MenuId.ViewTitle` and
   `MenuId.ViewContainerTitle` contributions.
5. ✅ Reduce the view container to the target launcher; delete
   `registerDelverView` and `delverViewContainer.ts`.
6. ✅ Records: ADR 0007, `ide-architecture.md` §1/§2/§4, the
   `workbench.common.main.ts` row in `patch-surface.md`, `ledger.md`,
   `status.md`.

### What the migration taught, worth keeping

Three defects had the same shape and none were caught by a type error: **a
gate that assumed one host.** Actions resolved their listing with
`instanceof DelverListingEditor`; `LISTING_ACTIVE` compared the active editor's
id; and the zone bound context off its selected segments without asking whether
the zone was visible. Each was silent — the feature simply did nothing, or did
it for a workspace nobody was looking at.

When adding anything that acts on "the current listing", state which host it
means. If the answer is "either", it must not be phrased as a question about
editors.

## 11. What must be tested

- Zone layout: sizing, minimum widths, sash behavior, persistence round-trip.
- The height-ownership guarantee itself: showing or hiding a surface in one zone
  must not change another zone's dimensions. This is the design's central claim
  and deserves a test that fails loudly if it regresses.
- Surface registry: `when` filtering, zone assignment, ordering.
- Selection-kind menu filtering: a function action must not resolve while a
  section is selected.
- Tear-off: the same widget renders in both hosts and disposes correctly in each.
