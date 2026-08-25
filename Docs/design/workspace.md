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
| **Navigator** | 240px | Functions, Strings, Imports, Exports, Sections | segmented — one at a time, full height |
| **Primary** | flex | Overview (default), Listing, Pseudocode | splittable side by side |
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

Five navigator surfaces become five *segments of one zone* rather than five
panes: one full-height list, four tabs. Segment switching does not resize
anything.

### Overview is the Primary zone's default

Overview is target-level summary, not a list to navigate, so it is what Primary
shows before anything is selected — the target's home. A home affordance in the
header returns to it. Making it a sixth Navigator segment would have filed a
summary among the indexes and cost a segment slot to something never consulted
mid-task.

## 3. Surfaces are widgets, hosted twice

A surface is a plain widget, not a `ViewPane` and not an `EditorPane`:

```ts
interface IDelverSurface extends IDisposable {
	readonly element: HTMLElement;
	layout(dimension: Dimension): void;
	setVisible(visible: boolean): void;
	focus(): void;
}
```

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
	readonly badge?: Event<number | undefined>;
	readonly tearOff?: (focus: IFocus) => EditorInput;
}
```

This is required by invariant 9 — the workspace hosts surfaces owned by
`delverFunctions`, `delverXrefs` and the rest, and may not import any of them.
It mirrors the `registerDelverView` indirection already in
`delverViewContainer.ts`, which exists for exactly this reason and which this
registry replaces.

## 5. Actions bind to selection, not to containers

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

Staged so the build is never broken:

1. Extract surface widgets out of the existing `ViewPane`s, behavior-preserving.
   Views keep working.
2. Add the surface registry alongside `registerDelverView`.
3. Build the workspace editor and zones; register surfaces into it.
4. Move actions to selection-scoped menus; delete the `MenuId.ViewTitle` and
   `MenuId.ViewContainerTitle` contributions.
5. Reduce the view container to the target launcher; delete `registerDelverView`.
6. Records: ADR 0007, `ide-architecture.md` §1/§2/§4, the
   `workbench.common.main.ts` row in `patch-surface.md`, `ledger.md`, `status.md`.

## 11. What must be tested

- Zone layout: sizing, minimum widths, sash behavior, persistence round-trip.
- The height-ownership guarantee itself: showing or hiding a surface in one zone
  must not change another zone's dimensions. This is the design's central claim
  and deserves a test that fails loudly if it regresses.
- Surface registry: `when` filtering, zone assignment, ordering.
- Selection-kind menu filtering: a function action must not resolve while a
  section is selected.
- Tear-off: the same widget renders in both hosts and disposes correctly in each.
