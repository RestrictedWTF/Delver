# 0013 — Accepted interpretation is an input to decompilation, not backend state

**Status:** accepted
**Date:** 2026-08-28
**Affects:** `CLAUDE.md` invariant 3 · [0005](0005-portable-project-database.md) ·
[0006](0006-proposal-resolution-in-the-edit-log.md) ·
[`architecture/data-model.md`](../../architecture/data-model.md) §3, §7 ·
`services/delver/common/delverDecompilerService.ts` ·
`services/delver/common/ghidraDecompilerProtocol.ts` ·
`platform/delver/common/delverAnalysisService.ts` ·
`platform/delver/node/pyGhidraDecompiler.ts` ·
`scripts/ghidra/delver_decompiler_worker.py` ·
`contrib/delverPseudocode/browser/delverPseudocodeWidget.ts`

## Context

Invariant 3 keeps facts and interpretation in separate stores. Data types and
function prototypes are the first authored interpretation that does not stay on
its own side of that line: a name or a comment decorates C that is still
correct, while a type **changes the C the decompiler emits**. Ghidra applies
only the types its program database holds, so making an accepted declaration
visible to the decompiler means writing it somewhere the backend reads — and the
only such place is the store [0005](0005-portable-project-database.md) calls a
disposable local accelerator, keyed by content hash and deletable at any time.

The second half of the problem was in Delver's own caches. Decompilation
identity was `(contentHash, functionRva)`, in the bounded memory cache and in
the `decompile_*` rows of a portable project alike. Accepting a type therefore
reloaded pseudocode produced against the superseded type model, and nothing in
the pane said so — confident, plausible C that is wrong, which this project
ranks above a crash. The pseudocode pane made it worse by treating every
authored edit as an overlay on output, because until this slice every authored
edit was one.

What we do not know: which functions a given declaration actually affects. That
needs type-reference analysis over decompiler output, and none exists.

## Decision

**Accepted interpretation is an input to one decompilation, and part of that
decompilation's identity. It is never written into the backend's own state.**

- Every decompilation request carries a versioned, content-wide
  `IDecompilationSemanticDependencies`: `schemaVersion: 2` plus the accepted
  `composite`, `dataType` and `functionPrototype` declarations for that content
  hash. A declaration is a canonical `0x…` RVA and a declaration string, unique
  and ascending by RVA; a composite is a named layout, unique and ascending by
  name, and the `composites` array is applied **before** the other two so a
  declaration can reference a struct the same snapshot introduced. The envelope
  is read from the materialized interpretation view, so only accepted edits are
  in it and a proposal is not ([0006](0006-proposal-resolution-in-the-edit-log.md)).
  Both decoders accept `schemaVersion` 1 and 2 and normalize a v1 payload up to
  v2 — a v1 snapshot *is* a v2 one with no composites, and normalizing on the way
  in is what keeps pseudocode saved before composites existed from comparing as
  stale. The key set is pinned per version, so a payload confused about its own
  shape is refused rather than guessed at.
- PyGhidra applies the snapshot inside a transaction opened for that one
  request and **rolled back unconditionally** — `endTransaction(id, False)` in
  the `finally` of `decompile_function`, on success exactly as on failure and
  cancellation. The persistent content-hash program database is left as
  analysis produced it, and each decompilation is a pure function of (bytes,
  function, accepted snapshot).
- The snapshot is part of decompilation identity. The in-memory cache key is
  `(contentHash, functionRva, digest of the snapshot)`, and the snapshot is
  recorded inside the saved result and compared before that text is reused. **A
  mismatch is skipped with a diagnostic naming the reason and the function is
  decompiled again — never served.**
- The snapshot is deliberately content-wide: it lists every accepted
  declaration in the image, not the ones a given function depends on. It
  invalidates more functions than strictly necessary, and it can never reuse
  pseudocode produced against a different accepted type model. The durable
  envelope is versioned so a later dependency graph can narrow the arrays
  without a format change.

## Alternatives

| Option | Why not |
| --- | --- |
| Persist the declarations into Ghidra's program database | What every other tool does, and the shortest path: apply once and every later decompilation sees it. It puts authored work — the analyst's actual output under invariant 3 — into a store [0005](0005-portable-project-database.md) defines as a disposable cache that may be deleted at any time. It also makes *revising or clearing* a declaration non-deterministic: the edit log no longer names the type and the backend still carries it, so the next decompilation answers with a type nothing in the project claims |
| Key the cache on a monotonic interpretation-version counter | Cheaper than digesting a snapshot on every lookup, and it can never under-invalidate. It over-invalidates in the wrong direction instead: a rename, comment, or tag — overlays on C that is still correct — throws away every function's pseudocode. A counter is also project-local, so two projects that arrived at the same accepted type model cannot recognize each other's saved results, which is what portable `decompile_*` rows exist for |
| Per-function semantic dependency graph from the start | The narrow invalidation this decision defers. It needs type-reference analysis over decompiler output that does not exist yet, and a graph that is wrong *under*-invalidates — the one failure that serves confidently stale pseudocode. Correct and coarse first; narrow once the dependencies can be measured rather than guessed |
| Do nothing; require an explicit refresh after accepting a type | Cheapest, and it is what the code did before. It makes correctness something the analyst has to remember at the moment they are least likely to — the type has just landed and the pane already shows C — and the wrong outcome is silent, which is the kind this project treats as a defect on its own |

## Consequences

**Makes easy**

- Revising or clearing a declaration is deterministic. The next decompilation
  runs against exactly what the log now says, with nothing carried over from the
  last one, because there is nothing left in the backend to carry.
- A project shared without its sample still knows which type model each saved
  function was built against: the snapshot is embedded in the saved result, so a
  reader's snapshot either matches or the row is skipped with a diagnostic.
- Ghidra's cache stays disposable, as [0005](0005-portable-project-database.md)
  requires. Deleting it costs re-analysis time and never authored work.
- The pseudocode pane can tell its two kinds of edit apart: an accepted type or
  prototype re-decompiles the function on screen, while a name, comment, or tag
  re-renders decorations, which is all those need.

**Makes hard**

- Invalidation is content-wide. One accepted type edit invalidates every cached
  and saved function for those bytes, and a project holding retained pseudocode
  for hundreds of functions pays for all of them until a dependency graph
  exists.
- The headless backend cannot apply types at all. It is therefore treated as
  answering against the **empty** snapshot: that is what its request carries,
  what its result is keyed and saved under, and what it is honestly attributed
  to. The result is marked `semanticsIgnored`, so a caller is told the accepted
  types were not applied rather than left to assume they were.

  This corrects an earlier reading of the same principle. Refusing outright
  looked like the honest answer, but it made *one* accepted type remove every
  function's pseudocode on that backend — saved text stopped matching the
  snapshot and nothing would produce new text — and it did so silently until a
  function was opened. Attributing an answer to the semantics it was really
  produced with is the honest move; refusing to answer at all was a different
  failure wearing honesty's clothes.
- The snapshot travels with every decompilation request. It is bounded at
  10,000 declarations per kind — checked in the renderer before the request is
  serialized, and again in the worker, which is the bound that actually refuses
  — and at 2,048 characters per declaration. A project past the bound is
  refused, never truncated: decompiling against *some* accepted types and
  presenting the result as though all of them applied is worse than not
  answering.
- Accepting a type spends a backend round trip the analyst did not explicitly
  ask for. The reload is an ordinary request rather than a forced refresh, so it
  can still be answered from cache or from saved pseudocode that matches the new
  snapshot, and its failure is swallowed — a backend that is down leaves the
  previous text alone instead of replacing it with an error.

**Would cause a revisit**

Exact per-function dependency stamps are deliberately not decided here. A
measured project where accepting one declaration re-decompiles an image's worth
of functions would force them, and that refinement narrows the arrays inside the
`schemaVersion: 2` envelope rather than reopening this decision.

A backend whose type application cannot be transacted would force a different
containment — a throwaway copy of the program database per decompilation — not a
return to persisting authored types into backend state.

## Related

- [0005](0005-portable-project-database.md) — backend-native state is a disposable cache, never the record of truth
- [0006](0006-proposal-resolution-in-the-edit-log.md) — why only accepted edits are in the snapshot
- [0014](0014-type-anchors-for-authored-composites.md) — extends this: authored composites carry no address, and the envelope moved to `schemaVersion: 2` to hold them
- `CLAUDE.md` invariant 3 — the separation this preserves against a backend that wants to own types
