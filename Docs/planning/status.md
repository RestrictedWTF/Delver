# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-08
**Current phase:** Stage F2 — inline interpretation surfaces landed

## Just landed

The listing now renders authored names at any RVA and comments after the operands
on their instruction line. Function starts retain their placeholder/authored landmark
line. Interpretation is owned by the real instruction row rather than inserted
as synthetic analysis rows, so paging ordinals and address mapping stay exact.

Each label is one bounded display line and adds one deterministic line height;
comments do not change row height. Imported multiline comments fold newlines only
for display while the stored value remains unchanged. Accepted edits re-splice
only their buffered row, updating immediately while preserving focus and selection.

`;` opens Set Comment while a listing row is selected; input focus suppresses the
shortcut so semicolons can be typed into the prompt. Empty input clears by
appending an empty-value edit. F2 Rename and Set Comment share one editing path.

Function rows now carry wire-safe RVA handles. Rename is an inline row action and
Set Comment is in the row context menu; both update the listing and Functions pane
through the interpretation event.

The inline-row decision is recorded in [p1-plan.md](p1-plan.md), and the listing
height constraint is updated in [ide-architecture.md](../architecture/ide-architecture.md).

Function names on listing landmark lines are now the product accent instead of
`symbolIcon.functionForeground`, through a registered `delver.listing.functionName`
color. Registering it exposed that the other four `delver.listing.*` IDs are
declared in the theme files but never registered — a theme entry for an
unregistered ID emits no CSS variable, so those four roles currently do nothing.
The listing's mnemonic and branch-target colors still borrow
`debugTokenExpression.*` and `textLink.foreground`. See
[rebranding-plan.md](rebranding-plan.md) §2.1.

Separately, the rebrand had replaced only the OS artwork under `resources/`, so
every renderer-drawn surface still showed the VS Code logo — most visibly the
titlebar app icon. Those come from source-tree SVGs
(`browser/media/code-icon.svg` and the four `letterpress-*.svg` watermarks), which
`scripts/generate-artwork.py` now traces from `resources/delver/logo.png` along
with the OS icons, so the whole set regenerates from one master.

## Verification

- Listing interpretation presentation: 4 passing
- Listing paging/model: 12 passing
- Functions interpretation handles: 2 passing
- Interpretation persistence/materialization: 3 passing
- Existing navigation test cannot run in the Node harness because its EditorPane
  import reaches CSS; this is a harness limitation, not a test assertion failure.

## Next

Visually verify inline comment layout, name-driven height changes, selection retention,
and the Function-row actions. EditorPanes have no UI tests in this fork.

After that, finish Stage F interpretation control: tags and compensating edits for
undo/revert-by-author. Rename/comment actions for Imports, Exports, and References
can then reuse the shared editing helper where those rows have meaningful image RVAs.

## Known limitation

Wrapped/unbounded source or pseudocode interleaving still needs a custom dynamic
list delegate. Comments deliberately remain bounded on the instruction line.
