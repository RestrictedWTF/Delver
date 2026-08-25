# 0007 — Delver surfaces live in a workspace editor, not a sidebar container

**Status:** accepted
**Date:** 2026-08-26
**Affects:** [`architecture/ide-architecture.md`](../../architecture/ide-architecture.md) §1, §2, §4 ·
[`design/workspace.md`](../../design/workspace.md) ·
`services/delver/browser/delverViewContainer.ts` ·
every `contrib/delver*/browser/*.contribution.ts`

## Context

[`ide-architecture.md`](../../architecture/ide-architecture.md) §1 decided that
Delver's views are ordinary workbench contributions living in a sidebar view
container, and explicitly rejected a separate layer: *"Delver's views live
inside the normal workbench alongside editors and terminals, so they're
contributions. Revisit only if Delver later grows a dedicated standalone
window."* That was correct at the time and is not what this ADR overturns — the
workspace editor is still a contribution, still inside the normal workbench.
What changes is the **container**.

By the end of P3, eleven surfaces were registered as `ViewPane`s into
`workbench.view.delver`. Three failures followed, and all three are structural
rather than cosmetic:

- **Height is shared.** A `ViewPaneContainer` distributes its height across
  expanded panes by weight, so opening any surface shrinks every other one and
  closing it redistributes again. No arrangement an analyst makes survives their
  next click.
- **Peer surfaces are stacked as a sequence.** Functions, Strings, Imports,
  Exports and Sections all answer *what is in this binary?* and are consulted one
  at a time. Stacking them spends five headers and five scroll regions to show
  five slivers of five lists.
- **Actions bound to containers, not objects.** "Generate Signature" acts on the
  selected function but was contributed to `MenuId.ViewTitle`
  (`delverSignatureActions.ts:115`); six more went to
  `MenuId.ViewContainerTitle`. Icons appeared in title bars with no visible
  relationship to their subject.

Compounding all three, the sidebar's spacing is tuned for settings pages, while
[`design/principles.md`](../../design/principles.md) §2 requires density inside
data views.

One thing we did *not* know when §1 and §2 were written, and which materially
changes the arithmetic: §2 credits listing-as-editor with giving address history
"for free" via `EditorInput` history. In fact `IDelverFocusService` now owns a
real history stack — `back()`, `forward()`, proximity coalescing,
`FOCUS_HISTORY_ORIGIN` — so that dividend is already ours independent of the
host. Moving the listing out of an editor tab costs nothing there.

## Decision

**Delver's surfaces move into a workspace editor: one `EditorInput` per open
target, divided into three fixed-role zones — Navigator, Primary, Inspector.**
Each zone is an independent flex column with its own scroll, so no surface can
resize another; only the sashes between zones move. Surfaces become plain
widgets registered into a registry in `services/delver/`, hostable both by a
zone and by a thin `EditorPane` for tear-off into a real editor tab. Actions
bind to a `delver.selectionKind` context key and surface only through the
context menu, keybindings, and the command palette; a zone header may hold
nothing but `pin` and `sync`. The view container survives with exactly one
view — a target launcher — solely because activity-bar entries are view
containers upstream.

Full specification: [`design/workspace.md`](../../design/workspace.md).

## Alternatives

| Option | Why not |
| --- | --- |
| Keep the sidebar container, restyle it | Does not touch the cause. Eleven panes sharing one height budget will renegotiate on every click no matter how they are painted, and the container title bar will keep collecting object-scoped icons. |
| Custom `ViewPaneContainer` subclass in the sidebar | Fixes the accordion but keeps every surface inside a ~300px column. `principles.md` §2 requires tabular alignment across address, bytes, mnemonic and operand columns; a listing and its pseudocode cannot sit side by side in a sidebar at any spacing. |
| Separate `src/vs/delver/` layer and window, as `vs/sessions/` does | Maximum design freedom at the cost of rebuilding layout persistence, editor groups, tabs, and history. `ide-architecture.md` §1's reasoning still holds: that layer exists for a separate *window* with a different shell, which Delver is not. Reconsider only if Delver grows one. |
| Dockable grid with saved named layouts (Ghidra/Visual Studio model) | The zone guarantee — no surface can shrink another — cannot survive arbitrary nesting, and free arrangement lets an analyst rebuild the exact flooding this ADR exists to remove. Deferred, not rejected forever; §7 of the design doc records what evidence would reopen it. |
| Task modes (Triage / Analyze / Compare) instead of zones | Attractive, but modes are *presets over* a zone model rather than an alternative to one. Cheap to add later once zones exist; expensive to retrofit zones underneath modes. |
| Patch `activitybarPart.ts` for a container-less activity icon | `PaneCompositeBar` builds items from `viewDescriptorService.getViewContainers()`; the only container-less entries are the two hardcoded globals in `globalCompositeBar.ts`. Two **High**-risk `patch-surface.md` rows on high-churn upstream files, carried against every rebase, to avoid one small view. |

## Consequences

**Easier.** Density becomes achievable — a listing and its decompilation sit
side by side at full height, with the tabular alignment `principles.md` §2
requires. Navigator surfaces stop competing: five panes become five segments of
one full-height list. Object-scoped actions become structurally incapable of
landing in a container's chrome, so §1's third failure is unrepresentable rather
than merely discouraged. Adding a surface no longer costs every existing surface
some height.

**Harder.** Every surface must be extracted from its `ViewPane` into a widget
hostable in two places, and each must dispose correctly in both — a real
refactor across all eleven surface-owning contributions, staged in
[`design/workspace.md`](../../design/workspace.md) §10 so the build never
breaks. Discoverability drops: with no persistent action chrome, nothing on
screen advertises that a feature exists, which is mitigated by inline
keybindings in context menus and `Delver:`-prefixed palette entries but not
eliminated. Three zones now render concurrently against a paging analysis
server, so each must distinguish "no data" from "not yet loaded" from "failed" —
a blank Inspector that reads as "no callers" is a silent false negative.

**We would revisit if** an analyst workflow proves genuinely blocked by fixed
zone roles — the likely candidate is multi-target work, where a dropper, its
payload and a memory dump want comparison across targets rather than within one.
The escape hatch to reach for first is moving a surface between zones, then
task-mode presets; a general dock canvas is the last resort, because it forfeits
the height-ownership guarantee that motivated this decision.
