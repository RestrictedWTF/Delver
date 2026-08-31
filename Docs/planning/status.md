# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/). For what is *wrong*
with what exists, see [defect-audit.md](defect-audit.md) — a full read of the
codebase on 2026-08-26, ranked, with the fixed rows deleted as they land.

---

**Last updated:** 2026-08-31
**Current phase:** P3c/P3d — reviewed evidence plus static-analysis depth (P3b client conformance and P3a/P2b real-project smoke continue alongside)

Everything older than the entries below is in
[development-log-2026-08.md](../history/development-log-2026-08.md) — the August
working notes, verbatim and unmaintained. Read it only when you need the
reasoning behind something, not to find out where things stand.

## Just landed

**Two questions were answered without shipping anything.** Naming a local
variable is blocked on identity, not plumbing: the only anchor the backend
offers is `storage`, and decompiling `SUB_E2A0` reports both `_Src` and `piVar1`
at `unique:00023e00:8` — a Ghidra SSA temporary, not a place in the binary. A
rename anchored there would attach to two variables at once and be lost on the
next decompilation. Recorded in the ledger; a durable identity has to be
designed before the rest of that slice is worth building.

Compiler-metadata recovery got its bounded read-only spike instead of a
schedule slot: 69 System32 PE32+ images, 38 of them carrying validated MSVC RTTI
that names 4,130 distinct classes, and the images with none are C code. The
number that decides it is the funnel — 211,686 candidates match `signature == 1`
and 4,824 survive the check that the locator's `pSelf` points at its own RVA, so
one comparison removes 97.7% of them. The spike covered only the locator →
type-descriptor edge, so the zero-false-match bar is unmet and this stays P5.
The recommendation in
[the idea](ideas/compiler-metadata-semantic-recovery.md) is *schedule, do not
start*.

**Cancelling a decompilation now cancels it.** `StubTaskMonitor.cancel()` is a
no-op, so every layer above reported a cancellation that never happened while
Ghidra kept the worker — and backend work is serialized, so it blocked the next
request too. `TaskMonitorAdapter(True)` fixes it; a full analysis cancelled four
seconds in now returns in 4.1s rather than running the full 24. A cancelled run
also stopped claiming `analysisComplete: true`. Analysis progress reporting
works on `TaskMonitorComponent` — phase name only, never a fraction, because
each analyzer resets the maximum for its own step.

**Unions and enums ship end to end** — proposal, type anchor, review,
`schemaVersion: 2` snapshot, transactional application, and a `UnionDataType` or
`EnumDataType` in PyGhidra. Neither bumps the snapshot version: a version pins
the envelope's key set and `kind` is a value, so an older worker refuses an
unknown kind by name, which is the direction to fail in.

**The cross-backend function handshake is done, and repair was declined on
measurement** ([ADR 0017](../history/adr/0017-cross-backend-function-handshake.md)).
Against fully analyzed programs the backend's coverage gaps are 82 and 8
boundaries, of which **zero** are vouched — every one is a Delver linear-sweep
guess. There is nothing to push, and pushing the rest would ask a decompiler to
create functions where nothing vouches for them.

## Just landed — structured constant search

`delver_search_immediates` closes a gap the dispatcher row named and the old
tool's own usage text admitted: `delver_search_instructions` matches *formatted
operand text*, and one constant reaches the listing as `0x1f4`, `500` or `1F4h`
depending on the formatter. The new capability matches the value the bytes
encode.

Two decisions carry it. A field is matched by **both** its unsigned and its
sign-extended reading, because the bytes do not record whether the programmer
wrote `-1` or `0xFFFFFFFF` — on `Auto-updater.exe`, searching `0xffffffff` finds
370 dword forms and searching `0xffffffffffffffff` finds 578, the same ones plus
every byte-width encoding. And **branch displacements are excluded**: a `jmp`
encodes a destination, not a number, so including it would make a search for
`0x1000` match every jump that lands there.

The search walks the instruction index rather than scanning bytes, so every
candidate starts at a boundary the analysis established — decoding from an
arbitrary offset produces plausible garbage that differs silently from the real
stream (Stage D, F2).

Working on the real sample: `0x5a4d` — `MZ` — returns exactly two hits, which is
this binary checking PE magic in two places.

## Where to pick up

- **Local variable naming needs a durable identity design** before any of its
  plumbing. That is the largest remaining gap in the reading workflow and it is
  a design question, not a build one.
- **The type-system row continues**: local variables and stack frames, and type
  propagation. Unions and enums are off it.
- **Merge and conflict detection** remain collaboration work, untouched.
- **Discontiguous pseudocode selection painting** is still the next UI-side P2
  slice. Wrapped or unbounded source and pseudocode interleaving still needs a
  custom dynamic list delegate.
- **Indirect call resolution's weaker half** — a vtable or dataflow-derived
  target on the `probable` tier — is what holds `delver_call_graph` and
  `delver_call_paths` at `partial`.
- **Compiler-metadata recovery is scheduled, not started.** P5.

Live checks are outstanding wherever a change was only unit-verified; the UI
paths in particular were reasoned about, not driven.
