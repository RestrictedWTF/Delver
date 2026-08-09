# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-08
**Current phase:** Stage G6 — workspace pane polish complete

## Just landed

Functions and Imports now have persistent, debounced filter boxes. Function
filtering covers authored/placeholder names, RVAs, and source across the complete
set; Imports covers modules, symbols, ordinals, and IAT RVAs.

The Functions pane no longer stops after 1,000 swept entries. Large categories
are exposed as lazy 1,000-row pages, so all ~178k results remain reachable while
each expansion and refresh stays bounded. Rename refresh is now incremental and
does not rescan every function for comment or tag edits. Strings already lives in
an editor page with its own filter and encoding column, completing G6.

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

Tags are stored as canonical arrays and render inline as `#tag` tokens. `T` edits
the selected instruction's tags. Imports, addressed Exports, References, and
Functions expose the same Rename, Set Comment, and Set Tags row actions; forwarded
exports remain excluded because they have no RVA in this image.

`Ctrl+Z` now undoes local interpretation with an attributed compensating append.
It walks backward through uncompensated accepted edits without rewriting history.
`Delver: Revert Interpretation by Author...` reconstructs state without one
author's accepted edits and appends one compensation per affected field. Merged
imports are resequenced so compensation references remain unambiguous.

Listing navigation also maps Mouse4/Mouse5 to the existing focus-history
back/forward stack. The events are captured before the table or Chromium can
consume them, and Alt+Left/Alt+Right remain equivalent keyboard paths.

References now render proven function-relative locations such as
`decrypt_config+0x2A`, with the raw RVA and reference kind in the description.
Exact entries use the function name; addresses without a known containing range
remain raw rather than being attributed to a guessed owner. Renames refresh the
pane immediately.

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

- Interpretation model/service/store, listing presentation, and handles: 25 passing
- Mouse history mapping plus focus-history behavior: 12 passing
- Function-relative reference labels: 2 passing
- Functions paging/filtering and Imports filtering: 5 passing
- Listing paging/model: 12 passing
- Functions interpretation handles: 2 passing
- Targeted ESLint: clean on all changed interpretation and pane-action files
- Existing navigation test cannot run in the Node harness because its EditorPane
  import reaches CSS; this is a harness limitation, not a test assertion failure.

## Next

Visually verify inline tags, sequential `Ctrl+Z`, author reversion, and the row
actions in Functions, Imports, Exports, and References. EditorPanes have no UI
tests in this fork.

After visual acceptance, the next bounded workspace follow-up is R1: make Overview
rows navigate to the entry point, listing, Functions, and References. Types remain
a later interpretation extension; merge and conflict detection remain collaboration
work.

## Known limitation

Wrapped/unbounded source or pseudocode interleaving still needs a custom dynamic
list delegate. Comments deliberately remain bounded on the instruction line.
