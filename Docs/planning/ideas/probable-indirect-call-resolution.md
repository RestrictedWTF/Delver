# Probable indirect call resolution from vtable slots

**Status:** open

## What

`ResolutionConfidence::Probable` exists and nothing produces it. The vtable slice
([ADR 0019](../../history/adr/0019-vtable-slice-bounded-by-recovered-functions.md))
is the input it was reserved for: 4,832 recovered tables carrying 30,839 slots, each
slot a `(decorated class name, index, recovered function entry)` triple. The question
this file answers is what wiring those slots into `delver_call_graph` and
`delver_call_paths` would actually buy, and the answer is less than the `status.md` line
implies.

## What a vtable slot establishes about a call site

A slot establishes: *class `C`'s vftable dispatches function `F` at index `N`*. That is
a fact about a table in `.rdata`. A call site is `call [rax+0x18]`, and turning the fact
into a resolution needs three further steps:

1. `rax` holds a vptr, not some other pointer — unknown without dataflow;
2. the vptr is `C`'s and not another class's — this is the type-recovery problem, and
   it is the whole problem;
3. `0x18` indexes the slot array from the vptr rather than a field of the object.

Delver has none of the three. There is no dataflow analysis, no type recovery, and
`resolve_slot_operand` deliberately reads only the instruction's *own* data xrefs — one
xref, or nothing. Step 3 alone is derivable from the displacement, and it is the step
worth nothing on its own: knowing a site calls "slot 3 of something" narrows 30,839 slots
to whatever number of tables have at least four slots, which across this corpus is most
of them.

What *is* derivable with zero dataflow is one narrow case: a call site whose sole data
xref lands on a known vtable slot RVA — `call [rip+X]` where `X` is a slot. This is
exactly the shape `resolve_iat_operand` already handles, with the vtable table in place of
the import table, and it is `Exact` rather than `Probable`, because the operand *is* the
evidence. It is also the case that essentially does not occur: a compiler that could emit
a rip-relative direct load of a fixed slot has already devirtualized the call and emits a
direct `call`, which the decoder names without help. This should be measured before it is
built, and the prediction is a count near zero.

**The honest statement is therefore: without type recovery, a vtable slot resolves
approximately no indirect call sites.** That is the finding. A resolver built anyway would
have to pick a class for the site, and every rule available for picking one — "the only
class in the enclosing function's data xrefs", "the class whose constructor is nearest",
"the only table with a slot at this index" — is a guess dressed as evidence, which is what
principle 1 and the `Probable` doc comment both exist to prevent.

### The direction that does work is the reverse one

Slots are useful read backwards. `delver_call_paths` fails to prove absence because an
unresolved indirect site *might* reach the sink. Vtable membership speaks to that: if the
sink function `F` appears in no vtable slot and has no data xref anywhere, an indirect
site is a less plausible route to it; if `F` is slot 7 of three classes, the site is a
plausible route and the search is right to refuse.

This narrows and annotates. It does not prove: soundness would require enumerating every
way an address can reach a register, including computed and relocated ones, which Delver
cannot claim. So it can improve the *explanation* attached to a refused absence claim —
"three unresolved sites on the frontier; the sink is dispatched at slot 7 of
`.?AVICDPActivity@cdp@@`" — without changing `proves_absence()` at all. That is a smaller
feature than the `status.md` line describes and it is the one with a defensible claim
behind it.

## The type change, if it is made

`ResolvedImport` is import-shaped — `iat_rva`, `module`, `symbol`, `ordinal` — and an
in-image target has none of those fields. The widening splits the payload from the
provenance:

```rust
/// What an indirect site was resolved to.
pub enum IndirectTarget {
	/// An import table slot the import table names one symbol for.
	Import(ResolvedImport),
	/// A function in this image, named by a vtable slot.
	VirtualMethod {
		/// Entry RVA of the recovered function the slot names.
		function_rva: u64,
		/// RVA of the slot itself — the evidence, not a summary of it.
		slot_rva: u64,
		/// Decorated class name from the type descriptor. Not demangled;
		/// ADR 0019 keeps demangling in P5.
		decorated_name: String,
		/// Zero-based slot index.
		index: u32,
	},
}

/// One resolution, with how it was obtained and how far it can be trusted.
pub struct IndirectResolution {
	pub target: IndirectTarget,
	pub method: IndirectResolutionMethod, // + VtableSlot variant
	pub confidence: ResolutionConfidence,
}
```

`IndirectCallSite::resolved` becomes `Option<IndirectResolution>`. `ResolvedImport` keeps
its fields but loses `method` and `confidence` to the wrapper, which also cleans up
`CallGraphEdge::resolved_import` and `CallPathStep::resolved_import` — those two stay
import-only and should not widen, because a thunk into a vtable is not a thing that exists.

**The cardinality is the harder half of the shape and it is not the implementer's to
decide.** A vtable-derived answer is naturally a *set*: with a class fixed, one target;
with a class unknown, every class whose table has index `N`. `Option<T>` cannot express
"one of these twelve, and the list is complete", and if it is forced to, the resolver has
to pick, which returns us to guessing. Either `IndirectResolution` carries
`targets: Vec<IndirectTarget>` plus a `candidates_complete: bool`, or the project decides
that an over-approximate candidate set is not a "resolution" at all and belongs in a
separate field. That is a data-model decision, not an implementation detail, and under
invariant 14 it needs recording before anything is built.

On the wire this is a breaking change to `IndirectCallSiteWire.resolved`, which is today
flat and read by TypeScript as `resolved.symbol`. A serde-tagged enum (`{"kind":"import",
…}` / `{"kind":"virtualMethod", …}`) is the shape; `function_rva` and `slot_rva` are
`"0x…"` strings (invariant 2) and `protocol.generated.ts` regenerates from the crate
(invariant 12).

## The effect on completeness reporting

`proves_absence()` currently requires `unresolved_indirect_sites_on_frontier == 0`, and
`delver_call_graph` reports `partial` when `unresolved_indirect_call_site_total > 0`. A
probably-resolved site is a third state and the temptation is to count it as resolved,
which would make graphs go `complete` on the strength of a narrowing that by construction
"narrows the target without proving it".

**Recommendation: a `Probable` resolution does not clear the unresolved counter.** Keep
`unresolved_indirect_call_site_total` meaning *not exactly resolved*, and add
`probable_indirect_call_site_total` as a strict subset of it. `proves_absence()` is
unchanged, `partial` stays `partial`, and the probable target is visible as an
investigative lead rather than as a completeness claim. The alternative — probable clears
the flag — makes `complete` mean "every call was resolved or guessed at", and a model
consuming that envelope has no way to tell those apart.

The uncomfortable corollary, and it should be said rather than buried: **on this design,
wiring vtables into the graph does not lift `delver_call_graph` or `delver_call_paths` off
`partial`.** The `status.md` line is wrong about that, and it is wrong for a good reason —
only an exact resolution can, and only type recovery produces exact virtual resolutions.

## What could go wrong

**Truncation, at a measured rate.** 460 of 4,832 tables (9.5%) are shorter under the
recovered-function admission rule, 179 of them by more than four slots, worst case one
slot reported of fifty-five. A resolver that says "slot 12 of `C` does not exist, so this
site cannot be that class" is reading a truncation as a fact. Any candidate set derived
from tables must treat a `NotAFunction` terminator as "unknown beyond here", which means
9.5% of tables can only ever produce open-ended answers. Thirty tables recover zero slots
and are pure noise for this purpose.

**ICF folding makes the reverse map many-valued and misleading.** Identical-code folding
means one function is legitimately many classes' method — a trivial destructor or a
`return 0;` override folds across dozens of unrelated classes. A "which class does this
site dispatch on" answer derived from a folded target is not narrowing, it is a list of
every class that shares a one-instruction body. The corpus was never measured for fold
rate; that measurement should precede any candidate-set feature.

**Coverage is under half the corpus.** 38 of 69 System32 images carry RTTI. `ntdll.dll`,
`appinfo.dll` and every C binary get nothing, and neither does anything `/GR-`, packed, or
with a custom runtime — which describes most malware. A feature whose value is
concentrated in the images least likely to be under analysis is worth less than its slot
count suggests.

**A `Probable` target is a name, and names propagate.** Once a decorated class name appears
next to a call site in `delver_call_graph`, it will be read as the callee. Renderings must
carry the uncertainty, and a probable resolution must never feed auto-promotion, which
today is reserved for verified import thunks.

## Recommendation

**Blocked on type recovery. Do not build the resolver.** The producer does not exist and
cannot be faked: without knowing the object's type at the site, no rule over vtable slots
resolves `call [rax+0x18]` without guessing, and a guess on the `Probable` tier is
strictly worse than the current honest `partial`.

Three things are worth doing now, in order:

1. **Correct `status.md`.** "The weaker half of indirect resolution" is not blocked on
   vtables — vtables landed. It is blocked on type/dataflow recovery, and no entry in
   `Docs/` said so before this one.
2. **Two measurements**, read-only, no shipped code. Count indirect call sites whose sole
   data xref lands on a recovered vtable slot — the prediction is near zero, and if it is
   not, that is an `Exact` resolution worth having and this whole file is wrong. Count how
   many of the 30,839 slot targets are shared across two or more classes, which sizes the
   ICF problem before anything depends on the reverse map.
3. **The sink-side annotation** — report, on a refused absence claim, whether the sink
   appears in any vtable slot. It improves the explanation without touching
   `proves_absence()`.

The type widening itself is ≈400–600 lines across `delver-analysis`, `delver-protocol`,
the generated TS and their tests — mechanical — but it should be done *with* its first
producer, not before one. A widened enum with one inhabited variant is a migration cost
paid twice, and its cardinality question cannot be answered honestly until something real
needs to populate it.

**What unblocks it:** any analysis that establishes an object's type at a call site.
Constructor vptr-write recognition is the cheapest candidate — a function that writes a
known vftable RVA into `[this]` types `this` for that function's body, which resolves
virtual calls made on `this` in constructors and destructors. That is a genuinely bounded
sub-problem, it is on the enricher list in
[compiler-metadata-semantic-recovery.md](compiler-metadata-semantic-recovery.md), and it
is where the next spike should go.

## What would settle it

The measurement in step 2. If more than a negligible number of indirect sites have a
direct data xref to a vtable slot, there is an exact resolution here and this file's
recommendation is wrong. If the ICF share of slot targets is small, the reverse map is
worth more than argued above. Both are read-only scans over the corpus ADR 0019 already
used, and either result changes the recommendation rather than confirming it.

## Open decisions this file does not take

- **Cardinality of a resolution.** A vtable-derived answer is naturally a set, and
  `Option<T>` cannot hold "one of twelve, list complete". Whether an over-approximate
  candidate set counts as a resolution at all, or belongs in a separate field, is a
  data-model decision.
- **Whether `Probable` clears the unresolved counter.** The argument above says no, but
  that redefines what `complete` means to every agent consumer and is a project stance,
  not an implementation choice.
