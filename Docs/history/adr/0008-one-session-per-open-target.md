# 0008 — One session per open target

**Status:** accepted
**Date:** 2026-08-26
**Affects:** `services/delver/common/delverSessionService.ts` ·
[`design/workspace.md`](../../design/workspace.md) ·
[ADR 0007](0007-workspace-editor-over-sidebar-container.md) · every surface that
reads `activeSession`

## Context

The workspace editor is **per target** — one `EditorInput` each, so two targets
means two editors. `IDelverSessionService` is **single target**: it holds one
`_activeSession`, and `doOpen` closes the previous session before opening the
next.

Those two facts cannot both stand. Opening a dropper and its payload produces
two workspace tabs that show the same binary's data, and the second tab's header
sticks at "Opening target…" while its listing renders the first target's
instructions. Observed live on 2026-08-26 with `notepad.exe` and `kernel32.dll`.

The mismatch **predates the workspace redesign** — the sidebar could only ever
show one target, so nothing exposed it. ADR 0007 made it reachable.

What the investigation changed: `IDelverAnalysisService` is **already fully
session-keyed**. Every method takes an `AnalysisSessionId`, and the Rust analysis
server holds sessions independently. The single-target assumption lives in
exactly one workbench-layer field. Multi-session is not a protocol or backend
change; it is a pointer change plus bookkeeping.

The service's public surface is also, usefully, *implicitly* scoped:
`functions()`, `imports()`, `exports()`, `strings()`, `imageInfo()` take no
session argument and read the active one. Roughly 57 call sites across 19 Delver
files rely on that. If the active pointer becomes correct, those call sites
become correct without being touched.

## Decision

**The session service holds a map of sessions keyed by target path, and
`activeSession` becomes a derived pointer that follows the focused workspace.**

Opening a target no longer closes the previous one. The workspace editor tells
the service which target it is showing when it becomes visible; every implicit
call then resolves against that target.

Per-session state moves into the map with the session — notably
`isProjectDirty` and `projectPath`, which are properties of *a* project, not of
the service. Shutdown vetoes if **any** session is dirty, not just the focused
one.

This is deliberately the **hybrid** step. Consumers keep calling the implicit
API and keep working. Migrating them to resolve a session explicitly from their
workspace context happens incrementally, file by file, as each is touched. The
end state is explicit session resolution everywhere; this ADR is the step that
makes the product correct without a 19-file rewrite in one change.

## Alternatives

| Option | Why not |
| --- | --- |
| Leave it: one target at a time, workspace editor becomes a singleton | Honest and nearly free, but it discards a capability the backend has already paid for — `IDelverAnalysisService` is session-keyed throughout — and it contradicts the target launcher, which lists "Open Targets" in the plural. Comparing a dropper against its payload is a core malware-analysis workflow, not a luxury. |
| Full migration to explicit session resolution in one change | Correct end state, wrong first step. It rewrites ~57 call sites across 19 files at once, including the AI agent service, with no intermediate point where the product is verifiable. The bug is a wrong pointer; fixing it should not require touching every reader of that pointer. |
| Key sessions by content hash rather than target path | Two copies of the same bytes at different paths are genuinely one analysis, so the hash is the better long-term key. But the workspace input, the launcher's recents, and the editor's identity are all path-keyed today, and a hash is not known until after the file is read. Revisit with the interpretation store, which is already hash-anchored. |
| Serialise opens so only one workspace is ever live | Papers over the symptom. The second workspace would still exist, still be focusable, and still be wrong — it would just be wrong more slowly. |

## Where the assumption actually lived

Implementing this found the single-target assumption encoded in **three**
independent layers, each of which alone was enough to keep the bug alive:

1. **The session service** — one `_activeSession`, and `doOpen` closed the
   previous session before opening the next.
2. **`DelverWorkspaceInput`** — declared `EditorInputCapabilities.Singleton`,
   which permits one editor of a type in the entire workbench, so opening a
   second target *replaced* the first editor. `matches()` already keyed per
   target, which is the real requirement; `Singleton` was redundant and wrong.
3. **The open command** — after opening, `delver.target.open` swept closed every
   Delver editor whose resource was not the new target.

Fixing any one in isolation changes nothing observable, which is why the bug
looked deeper than it was. Worth remembering the next time a "single X"
assumption is lifted: search for it at every layer, because it will have been
re-encoded at each.

## Consequences

**Easier.** Two targets can be open and correct at once, which is what the
launcher already advertises. Every implicit consumer becomes right for free.
The AI analyst gains a well-defined answer to "which target am I analysing?",
which `ai-analyst.md`'s provenance rules need once an agent can reach across a
dropper and its payload.

**Harder.** Session lifetime is no longer "until the next open" — sessions now
outlive the thing that created them and must be closed when their workspace
closes, or analysis processes leak. Dirty-project prompting becomes
multi-valued: closing one target must prompt for that project, and shutdown must
consider all of them.

**The trap to watch.** `activeSession` is now *derived*, so any code that reads
it outside a workspace's context — a global command, a background task, an agent
tool — silently gets whichever workspace happens to be focused. That is the same
shape as every defect ADR 0007's implementation produced: a path that assumes a
single host. Prefer explicit session resolution in new code, and treat each
`activeSession` read that migrates as one fewer place this can bite.

**We would revisit if** hash-keying becomes the better identity (see
Alternatives), or if the incremental migration stalls — a hybrid that never
finishes migrating is worse than either end state, because it leaves two ways to
answer the same question.
