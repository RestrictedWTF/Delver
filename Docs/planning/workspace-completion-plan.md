# Workspace Editor Completion Plan — Phases 2–4

**Goal:** Finish the workspace redesign described by
[`design/workspace.md`](../design/workspace.md): a target-keyed editor with
Navigator, Primary, and Inspector zones; migrate every Delver surface; move
object actions off container chrome; and leave the activity-bar container with
only the target launcher.

**Verification authority:** The repository owner asked on 2026-08-26 to
continue until the redesign is done. For this plan, "done" includes the
narrowest relevant browser tests, client typechecking, and a launched-workbench
smoke test. This does not suspend invariant 15 for unrelated work.

## Constraints

- Preserve the unrelated dirty analysis/protocol/AI work already in the tree.
- No contrib imports another contrib's internals.
- No edits under `src/vs/workbench/api/**`.
- Every upstream edit is recorded in `patch-surface.md` in the same change.
- Addresses remain `bigint`; wire addresses remain `"0x..."` strings.
- Zone chrome uses upstream tokens and components. It should feel Calm and
  Focused: the reading surface leads, segment chrome stays quiet at rest, and
  data-view density is not traded away for decorative spacing.

## Phase 2 — Host and zones

1. Make the surface registry duplicate-safe, disposable, observable, and able
   to filter `when` clauses without global test leakage.
2. Add descriptor-owned, cancellable context binding as specified in
   `design/workspace.md` §3. Keep `IDelverSurface` host-only.
3. Add `DelverWorkspaceInput`, serialization, target-keyed layout state, and a
   thin `DelverWorkspaceEditor` host.
4. Build independent Navigator, Primary, and Inspector zone views on upstream
   `SplitView`. Persist widths and active segments per target.
5. Start Primary on Overview; switch to the Listing/Pseudocode reading pair on
   image focus; Home returns to Overview.
6. Test sizing, minimum widths, persistence, `when` filtering, badge updates,
   and the height-ownership guarantee.

## Phase 3 — Surface migration

1. Extract `DelverPseudocodeWidget` and `DelverStringsWidget`; keep their
   existing editor panes as thin tear-off hosts.
2. Register Listing, Pseudocode, and Strings with typed context binders and
   their existing tear-off inputs.
3. Register Functions, Strings, Imports, Exports, and Sections in Navigator;
   Overview, Listing, and Pseudocode in Primary; Xrefs, Signatures, and Review in
   Inspector. Preserve filter controls and Review's live pending-count badge.
4. Change target/project open paths to open `DelverWorkspaceInput`. Existing
   Listing/Pseudocode/Strings inputs remain valid tear-off targets.

## Phase 4 — Actions and launcher

1. Add `delver.selectionKind` and `delver.selectionAddress` ownership plus the
   single Delver selection-context menu. Move function/instruction actions there
   with palette names and keybindings.
2. Remove every Delver `ViewTitle` and `ViewContainerTitle` contribution. Keep
   only pin/sync state in zone chrome.
3. Replace the old multi-pane container with one target launcher containing the
   active target, recent targets, and Open Target/Open Project entries.
4. Delete `registerDelverView`, its reset-view roster, and obsolete sidebar-only
   hosting code once no surface calls it.

## Exit criteria

- Opening a target shows the three-zone workspace editor.
- Switching Navigator or Inspector segments never changes another zone's
  dimensions.
- Overview is the initial Primary surface; an address focus shows Listing and
  Pseudocode side by side; Home restores Overview.
- Segment choice and sash widths survive a workspace-editor reopen per target.
- Review shows a live count badge.
- No duplicate surface id can register.
- No Delver object action contributes to `ViewTitle` or `ViewContainerTitle`.
- The Delver sidebar contains exactly the target launcher.
- Listing/Pseudocode/Strings still tear off as real editor tabs.
- Targeted tests, client typecheck, and launched-workbench smoke are clean.
- `status.md`, `ledger.md`, and `patch-surface.md` describe the landed state.
