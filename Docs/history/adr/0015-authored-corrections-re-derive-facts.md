# 0015 — An authored correction changes what analysis derives from, not what it derived

**Status:** accepted
**Date:** 2026-08-28
**Affects:** `CLAUDE.md` invariants 3 and 5 ·
[0006](0006-proposal-resolution-in-the-edit-log.md) ·
[`architecture/data-model.md`](../../architecture/data-model.md) §3 ·
[`planning/mcp-complete-session-plan.md`](../../planning/mcp-complete-session-plan.md) §S5 ·
`delver-analysis/src/corrections.rs` · `delver-analysis/src/lib.rs` ·
`server-analysis/src/image.rs` · `server-analysis/src/main.rs` ·
`delver-protocol/src/message.rs` ·
`services/delver/common/delverFunctionCorrections.ts`

## Context

Function detection is a derivation, and derivations are wrong. Linear sweep
invents a function in data it mistook for code; a function nothing references
and nothing lands on is missed entirely. An analyst can often see both, and
until now had no way to say so — every authored edit Delver had was a
*decoration* on a derived fact (a name, a comment, a type), never a
contradiction of one.

S5 is the phase this opens: define and undefine code, data, and functions,
adjust bounds, patch bytes, each disclosed and recoverable. Function starts are
the first slice, and the one that decides the shape of the rest, because a
correction is the first authored thing whose subject is a fact rather than a
rendering of one. Invariant 3 says facts and interpretation are separate stores;
invariant 5 says interpretation is append-only and attributed. A correction has
to satisfy both while visibly changing what the fact store says.

What we did not know going in: whether "undefine" could be expressed as
suppression at all, or whether withdrawing a function start requires withdrawing
the instructions with it. It does not, and the two are worth keeping apart.

## Decision

**An authored correction changes the inputs analysis derives from, never its
output.** A `FunctionCorrection` is an addition to, or a suppression within, the
*function seed set*; `analyze_corrected` then re-derives every fact — decoded
instructions, function starts, basic blocks, the xref table, the listing index —
from the image bytes plus the corrected seeds.

- The correction lives in the authored log as an `EditOp.FunctionBounds` edit on
  an image anchor, so it is proposed, reviewed, accepted, compensated and
  reverted by exactly the machinery
  [0006](0006-proposal-resolution-in-the-edit-log.md) already defines.
  `functionCorrectionsFor` reads the *materialized* view, so a proposal
  contributes an address to review and nothing to the derivation. **Nothing is
  ever written into the fact store.** That is invariant 3 kept, and it is what
  leaves `analyze(bytes, seeds)` a total description of the facts. An edit to the
  *output* would leave the derived facts disagreeing with the thing they were
  derived from: the new function present in the list while the xrefs, call graph
  and basic blocks were computed as though it were not.
- `FunctionSource::Authored` **outranks every derived source, including
  `ExceptionDirectory`.** A person saying a function starts here is stronger
  evidence than anything the tool inferred. Authored starts are also seeded
  before image seeds, because `add_function` keeps the first extent it is given:
  going first is what lets an explicit `end_rva` pin an extent, while an absent
  one still inherits whatever detection infers for that address.
- Because `Authored.is_authoritative()` is true, a `Define` that carries an
  extent — pinned by the author, or inherited from a detected seed — also
  **suppresses sweep guesses inside that range**. A compiler-emitted range may
  hold unreachable code, jump tables and embedded data, none of which is
  evidence for a nested function; the same is now true of a range a human drew.
- **A correction set applies whole or not at all.** Two corrections at one
  address (`DuplicateAddress`, covering a repeat and a `Define`/`Undefine` pair
  alike) or a `Define` whose `end_rva <= rva` (`EmptyExtent`) refuse the entire
  set. The corrections are the *inputs* to a derivation: a half-applied set
  yields facts corresponding to no set anyone recorded — unreproducible, and the
  author is not told which half survived. `reanalyze` replaces nothing until the
  new analysis succeeds, so a refused set leaves the image exactly as it was
  rather than emptied.
- `analysis/setCorrections` **replaces** the set rather than merging into it, and
  re-derives without consulting the provider. Its result reports the function
  count before and after, the instruction count, and the number of corrections
  in effect — S5's disclosure requirement stated in the only terms the server
  can state it.

Two findings from building it, which the shape above does not imply:

- **`Undefine` cannot be a post-filter, and the obvious repair manufactures a
  bug.** Removing a seed is not enough: recursive descent rediscovers the address
  as a `CallTarget` the moment anything calls it, and linear sweep re-guesses it.
  But making the sweep *skip* an undefined start is worse — the sweep advances by
  a single byte on a skip, so undefining a guess at `0x1004` leaves those bytes
  unvisited and a fresh `LinearSweep` guess appears at `0x1005`. Undefining a
  start would manufacture a neighbouring one. The implementation instead lets the
  sweep walk the address normally and refuses it at the single choke point every
  discovery path funnels through, `Descent::add_function`, so the run is consumed
  and no neighbour appears. The refusal has to sit where addresses *become*
  functions, not where they are listed.
- **`Undefine` withdraws a function start, not the claim that the bytes are
  code.** The instructions stay in the index and inbound call xrefs stay in the
  table — a call is still a fact about the image; the author denied a function
  there, not the instruction that branches to it. Two tests pin exactly this. S5
  lists undefining *code* and *data* as separate operations, so "undefine" here
  is deliberately narrower than the word suggests and should be read as
  "undefine function".

Corrections name addresses, never bytes. **Byte-level patching is not part of
this decision**: nothing here reads or modifies the target's bytes.

## Alternatives

| Option | Why not |
| --- | --- |
| Patch the derived function list after analysis | The cheapest thing that appears to work — a post-filter over `AnalyzedImage::functions`. It makes the fact store internally inconsistent: the function exists in the list while the xrefs, basic blocks and call graph were computed from a seed set that never contained it, and the listing index still describes the instructions of the older analysis. Nothing downstream can then treat a fact as recomputable, because re-running `analyze` on the same bytes and seeds no longer reproduces what is being served |
| Write corrections into the fact store | Breaks invariant 3 outright, and the damage is not abstract: the fact store is a cache that is discarded and rebuilt, so the correction is lost the first time it is. It is also unattributable — a hand-edited function start carries no author and no timestamp, which invariant 5 exists to prevent — and unreviewable, since [0006](0006-proposal-resolution-in-the-edit-log.md)'s proposal lifecycle only reaches things that are edits in the log |
| Re-run the provider read as well as the analysis | Correct, and the simplest thing to reason about: close the image and reopen it with the new set. It is pure waste — `LoadedImage` already holds the bytes and their coverage, corrections cannot change either, and re-reading costs a provider round trip to learn nothing. It also discards the provider connection and every cached listing row, which is exactly what `setCorrections` exists to avoid |
| Merge partial correction updates instead of replacing the set | Convenient for a caller that wants to send one correction at a time. Two overlapping partial updates leave nobody able to say what set is in effect — and "what is in effect" is the only thing that makes a derived fact interpretable, since the facts mean nothing except as the output of `analyze(bytes, seeds)` for a *named* seed set. The caller already holds the whole accepted set; sending it is not the expensive part |

## Consequences

**Makes easy**

- Corrections are attributable, reviewable and undoable for free. They ride the
  existing append-only log, so an agent proposes one, a human accepts it, and
  compensation or per-author revert withdraws it — none of which needed new
  lifecycle machinery, because that machinery keys on `(anchor, op)`.
- A corrected image is exactly as reproducible as an uncorrected one. The facts
  are `analyze(bytes, corrected seeds)` either way, and `analyze` and
  `analyze_corrected` are the same function: corrections are a modifier on the
  one detection path, not a second path that could drift from it.
- Recovery is the ordinary path rather than a special one. Withdrawing the
  correction and re-deriving restores the previous facts exactly, because nothing
  was mutated in the first place.

**Makes hard**

- Every change to the correction set costs a full re-analysis of the image.
  `setCorrections` exists precisely so it does not *also* cost a provider round
  trip, but disassembly, descent, sweep and the xref build all run again for one
  corrected address.
- The listing index must be rebuilt with the analysis. `derive` is the single
  place both are produced, and `load` and `reanalyze` both go through it, so they
  cannot drift — a re-analysis that forgot the listing would serve rows for
  instructions that no longer exist.
- The refusal of a conflicting set is total, and reports one conflict: the first
  in the caller's order. An author who sent a large set with two bad entries
  fixes them one round trip at a time.
- Conflict rules live in the analysis crate only. `corrections_from_wire` catches
  shape errors — an `undefine` carrying an `end_rva` — and deliberately does not
  check conflicts, so there is one implementation of that rule rather than two
  that have to be kept in step.

**Would cause a revisit**

An image where re-analysis is slow enough that a correction feels like a stall
would force incremental re-derivation — recomputing only the region a correction
touches. That is a change to *how* the derivation runs, not to the principle that
a correction is one of its inputs, and it should be reached that way.

Byte patching arrives in the same S5 phase and does **not** fit this shape: a
patch changes the bytes, so facts derived from them are facts about something the
sample no longer is. It needs its own decision — disclosure, before-and-after
bytes, and a recovery story — and must not be bolted onto `FunctionCorrection`
because the two look superficially alike.

## Related

- [0006](0006-proposal-resolution-in-the-edit-log.md) — the proposal and acceptance lifecycle corrections inherit unchanged
- [0013](0013-accepted-semantics-as-decompilation-input.md) — the same move one layer up: authored work is an input to a derivation, never state inside it
- `CLAUDE.md` invariant 3 — preserved: the correction is in the log, and the fact store holds only what was derived
- `CLAUDE.md` invariant 5 — a correction is an authored, attributed, append-only edit like any other
