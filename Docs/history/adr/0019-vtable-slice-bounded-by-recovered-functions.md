# 0019 — A vtable slot is a recovered function, not an executable address

**Status:** accepted
**Date:** 2026-08-31
**Affects:** [`planning/roadmap.md`](../../planning/roadmap.md) P5 ·
[`planning/ideas/compiler-metadata-semantic-recovery.md`](../../planning/ideas/compiler-metadata-semantic-recovery.md) ·
[0017](0017-cross-backend-function-handshake.md) ·
`delver-format/src/rtti.rs` · `delver-analysis/src/vtables.rs`

## Context

Compiler-metadata recovery is a P5 item, and the read-only spikes written up in
[`compiler-metadata-semantic-recovery.md`](../../planning/ideas/compiler-metadata-semantic-recovery.md)
were run to decide whether it deserved that slot. They answered more than that.

Spike 1 measured the entry into the MSVC RTTI graph across 69 System32 images:
the `pSelf` self-reference check removes **97.7%** of
locator candidates, 211,686 down to 4,824. Spike 2 walked one edge further, to
the vftable the locator sits under. **4,779 of 4,779 validated locators have a
vftable** — the existence edge is structural, not heuristic, because the locator
check already did the discriminating.

So the part of P5 that yields something an analyst reads — a class name and the
functions it dispatches to — turns out to rest on two checks that are already
measured, and not on the class hierarchy descriptors, base-class arrays, virtual
inheritance or demangling that make up the rest of the item. That is an unusual
shape for a large deferred item: the leverage is not spread evenly across it.

What did *not* validate is where a vftable ends. Walking slots "until a pointer
that is not into executable memory" produced twenty tables of more than 64 slots
across those images, every one of them `std::bad_array_new_length` — a class with
two virtual methods, reported with up to **3,166 slots**. It is the last RTTI
vftable in `.rdata` in those images, so the walk leaves the table and continues
through whatever array of function pointers follows. A boundary check confirmed
the complement: **zero** walks ran into another locator-preceded vftable, so the
overrun is always into non-RTTI pointer data, which is why the obvious guard —
"stop at the next known vftable" — never fires on any of them.

A confident 3,166-method class is the exact failure mode this project ranks
worst, and the reason the item read "schedule, do not start."

## Decision

**A bounded vtable slice is lifted out of P5 and built now, and a slot is
admitted only when its target is a recovered function entry.**

- **Scope is MSVC x64 locators, their type descriptors' decorated names, and
  their vftables' method slots.** Class hierarchy descriptors, base-class
  arrays, virtual inheritance, demangling, the Itanium ABI and any class model
  stay in P5. `rtti.rs` parses the locator and the descriptor name and stops;
  it does not follow the hierarchy pointer.
- **x64 only, by the same measurement.** A 32-bit locator has no `pSelf` field,
  so the scan would have no discriminator at all. The module declines rather
  than running the check that was shown to carry the whole scan without it.
- **The admission rule is the recovered function set.** `recover_vtables` takes
  `&[Function]` and a slot counts only when its qword names a function *entry*.
  Executable-section membership is not the test; the runaway tables were all
  pointers into executable sections.
- **The vtable slice therefore depends on function recovery having run, and is
  not a parser that can stand alone.** This is the load-bearing consequence and
  the thing a future session gets wrong by default: `rtti.rs` in
  `delver-format` is a pure image parser, but `vtables.rs` is in
  `delver-analysis` because its terminator is an analysis result. Passing an
  empty function slice yields zero-slot tables rather than falling back to a
  weaker test, because the weaker test is what this exists to avoid.
- **Every walk records why it stopped.** `Vtable::terminator` is not optional —
  `NotAFunction` carries the address it rejected, and `NextVtable`,
  `NotBackedByFile` and `Cap` are distinct. A table with no recorded reason
  could not be told apart from one that was never walked.

## Consequences

**The error direction is inverted, and that is the whole trade.** Under the
executable-memory rule, missing structure produced *extra* slots: a two-method
class read as 3,166 methods, and nothing in the output said so. Under this rule,
missing structure produces *fewer* slots: if function recovery misses a thunk in
the middle of a table, the walk stops there and the class is reported with the
methods above it and none below.

Truncation is the safer direction — a short list of real methods is usable and a
long list of invented ones is not — but it is still an error, and it is not
self-announcing. A four-slot table and a table truncated at four slots are the
same object. That is precisely why the terminator is recorded per table and why
`NotAFunction` carries the rejected RVA: it is the only thing that distinguishes
"the array ended" from "function recovery missed a thunk", and it makes the
question answerable at a specific address instead of a global one.

**Measured once implemented, over the same 70 images.** The rule was adopted on
the strength of the defect it removes; this is what it actually did.

| | executable-memory rule | recovered-function rule |
| --- | --- | --- |
| tables over 64 slots | 20 | **13** |
| worst table | 3,166 slots | **619 slots** |
| total slots | 39,319 | 30,839 |

It is an improvement and not a cure, and the residue says why: 619 consecutive
qwords in `AboveLockAppHost.dll` all point at genuine recovered function
entries. The array following that vftable is a real table of real functions, so
no rule phrased over slot *targets* can end the walk there — the information
needed is where the next object begins, which the target of a pointer cannot
carry. Ending the boundary problem needs a data-symbol boundary, not a better
predicate, and that is not this slice.

Two numbers bound the cost of the trade. Thirty tables of 4,832 (0.6%) recover
zero slots — the truncation this ADR warns about, at its most extreme, and small
enough to enumerate rather than estimate. Every one of the 4,832 tables ended on
`NotAFunction`; `NextVtable`, `NotBackedByFile` and `Cap` never fired, so the
strict rule always stops first and the other three terminators are guards rather
than the common path.

`NextVtable` is in fact unreachable by construction, which is worth stating so
nobody later reads its absence as a bug or relies on it firing. Every vftable is
preceded at `-8` by the pointer to its own locator, and that pointer lives in
read-only *data*. A walk approaching the next table therefore meets that data
pointer one slot before it could meet the table start, and `NotAFunction`
rejects it there. The variant costs nothing and is kept as a guard against a
layout where the two are not adjacent, but it is not a path this corpus can
exercise.

**The truncation this ADR warns about was then measured, and it is not rare.**
Comparing the two rules table by table over the same corpus: 4,372 of 4,832
tables (90.5%) are identical under both, and **460 are shorter under this rule**,
179 of them by more than four slots. The worst are severe — several `cdp.dll`
interfaces report **one** slot where the executable-memory walk reports 55.

Those cases were run down rather than left as a rate, and the cause is not in
this module. In `.?AV?$Activity@VICDPActivity@@$$V@cdp@@`, slot 0 is a recovered
function and slot 1 is `0xF70C0` — inside `.text`, a real virtual method, and
**declared by neither `.pdata` nor Delver's function recovery**. It is a leaf
function with no unwind data, so the exception directory never named it and
nothing reached it to sweep it. The walk stops there and reports a 55-method
interface as a 1-method class.

Two things follow. First, the diagnosis this ADR proposed works: `NotAFunction`
carrying the rejected RVA is what made a five-minute answer possible, and none of
the 4,560 stopping addresses across the corpus lie inside a `.pdata` range —
so the walk never stops somewhere the compiler declared code, and the rule is
not firing spuriously. Second, the fix belongs to function recovery, not here.
Relaxing the admission rule would re-admit the 3,166-slot tables to recover
these; the coherent move is the opposite one — **feed vtable slots back as a
function-seed source**, so an address a vtable dispatches to is evidence of a
function start, and re-derive. That is a change to function recovery with its own
false-positive question, it is not part of this slice, and it is
[raised, not decided](../../planning/ideas/compiler-metadata-semantic-recovery.md).

Until then the slice's honest claim is narrower than "the virtual methods of a
class": it is *the virtual methods reachable through addresses Delver already
recovered as functions*, with the terminator naming where that gave out.

**It inherits function recovery's known faults.** [0017](0017-cross-backend-function-handshake.md)
measured what Delver's function set is and is not: 638 of 640 exception-directory
`delverOnly` boundaries were chained `RUNTIME_FUNCTION` fragments recovered as
starts. Over-recovery of that kind does not hurt here — a fragment entry that a
slot never points at is never consulted. *Under*-recovery does, directly, and the
reconciliation from 0017 is the instrument that would find it: a vtable whose
terminator is `NotAFunction` at an address a backend has a function for is a
coverage gap with a name.

**A vtable slot is a fact, not an interpretation** (invariant 3). Both inputs are
recomputable from bytes — the locator scan from the image, the function set from
analysis — so this is derived like every other fact and re-derived after an
authored correction ([0015](0015-authored-corrections-re-derive-facts.md)),
including when that correction defines the function a slot needed.

**It does not deliver a class model, and must not be described as one.** No
inheritance edge, no base-class relationship, no demangled name. What it
delivers is: for each recovered vftable, a decorated class name and a list of
function entries. The `probable` indirect-call tier that holds
`delver_call_graph` at `partial` is the obvious consumer, but consuming it is
separate work and is not decided here.

## Alternatives

| Option | Why not |
| --- | --- |
| Keep the executable-memory terminator | It is the rule a standalone RTTI parser has to use, it needs nothing from analysis, and it is right for 97.9% of walks. The other 2.1% is `std::bad_array_new_length` with 3,166 slots, in twenty images, with no signal in the output that anything went wrong. A confident wrong answer at that magnitude discredits the correct 97.9% alongside it — an analyst who sees one 3,166-method class has no reason to trust the eight-method one beside it |
| Wait and do all of P5 together | The default, and what the idea doc recommended before spike 2 ran. It treats the item as uniform when the measurement says it is not: the locator and vftable edges validate at 97.7% and 100%, and the hierarchy descriptors have not been looked at at all. Deferring a measured piece to keep it packaged with an unmeasured one buys nothing but the packaging, and P5 is far enough out that the measurement would be re-derived rather than read |
| Parse the class hierarchy descriptors too | The next structure along, and where inheritance edges come from. Nothing has measured it — spike 1 stopped at the type descriptor, spike 2 at the vftable — so it would be built on the same reasoning-without-numbers that produced the naive terminator. It also brings virtual inheritance, base offsets and multiple-inheritance subobject identity, none of which is testable without the `/GR-`, multiple-inheritance and malformed corpus the idea doc's "what would settle it" section still calls for |
| Bound the table by the next known vftable start | The obvious guard, and it costs nothing — `vftable_starts` is already collected, and it is kept as a terminator for the cases it does catch. It cannot be the *primary* rule, because the boundary check measured its failure directly: zero of the twenty runaways ran into another locator-preceded vftable. The last RTTI table in a section has no next table to stop at, and the last table is exactly where the overrun happens |
| End a table at the first slot something else references | Tested, not assumed, and rejected on the numbers: it ends 4 of the 13 runaways at exactly the right slot and would truncate 24 correct tables to do it. A vtable's interior slots are usually unreferenced, but "usually" is the whole problem — the rule trades a rare visible overrun for a commoner silent truncation, which is the direction this ADR spends its Consequences section arguing against |
| Admit any address inside a function's bounds, not just its entry | Tolerant of the fragment defect 0017 found, and it would truncate less. A slot pointing into the middle of a function is not a virtual method — it is a coincidence, or a jump table entry, or evidence that the bounds are wrong. Accepting it would trade a legible truncation for an illegible wrong slot, which is the same trade as the executable-memory rule at smaller scale |

## Related

- [0017](0017-cross-backend-function-handshake.md) — what the function set is, what it gets wrong, and the reconciliation that would surface a truncating gap
- [0015](0015-authored-corrections-re-derive-facts.md) — why an accepted function correction re-derives vtables rather than patching them
- [`compiler-metadata-semantic-recovery.md`](../../planning/ideas/compiler-metadata-semantic-recovery.md) — both spikes, and the rest of P5 this slice leaves behind
