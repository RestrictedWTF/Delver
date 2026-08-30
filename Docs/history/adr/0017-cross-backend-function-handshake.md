# 0017 — One reference frame for function boundaries, and honest placeholders

**Status:** accepted
**Date:** 2026-08-30
**Affects:** `CLAUDE.md` invariants 3, 4, 6 ·
[0001](0001-wire-protocol-framing-and-encoding.md) ·
[0005](0005-portable-project-database.md) ·
[0013](0013-accepted-semantics-as-decompilation-input.md) ·
`scripts/ghidra/delver_decompiler_worker.py` ·
`platform/delver/common/delverFunctionReconciliation.ts` ·
`platform/delver/common/delverFunctionAdjudication.ts` ·
`platform/delver/common/naming.ts` ·
`platform/delver/node/pyGhidraDecompiler.ts` ·
`delver-format/src/pe.rs` · `delver-analysis/src/lib.rs`

## Context

Delver recovers functions itself, and so does every decompiler backend it
drives. Nothing compares the two, so the disagreement is invisible except where
it leaks into pseudocode as a name the analyst cannot click.

Two symptoms, one cause. A call whose target Ghidra has no function for prints
as `func_0x00014001d7a0` beside `SUB_E2A0` in the same pane — an absolute
address, in a codebase whose invariant 4 exists to keep absolute addresses out
of anything durable, and a naming convention that appears nowhere else in
Delver. `normalize_generated_function_names` rewrites `FUN_<absolute>` to
`SUB_<rva>` and matches nothing else, so the fallback form survives untouched.

Adding a second backend makes this worse in a specific way. Pairwise
comparison — Delver↔Ghidra, Delver↔IDA, Ghidra↔IDA — is N² relationships, each
needing its own reconciliation rules, with no principled tiebreak.

Delver's own set carries something no backend returns: `FunctionSource` records
*why* each boundary is believed, and `is_vouched()` separates evidence from
guess. A diff against it is therefore not symmetric, and that asymmetry is the
useful part.

## Decision

**Delver's function set is the reference frame every backend is reconciled
against, and a name that no function backs says so.**

- **Star, not mesh.** Each backend reconciles against Delver's set and against
  nothing else. Adding IDA is one adapter, and touches no existing comparison.
  Backends never learn about each other. Cross-backend signal is still
  available — two backends disagreeing with Delver identically is evidence
  about Delver — but it is read off the reconciliations, not plumbed between
  backends.
- **The reconciliation is a fact, and it is total.** Per `(contentHash,
  backendId)`, a join over the *union* of entry RVAs. Every RVA yields a row,
  classified `agree`, `boundsDiffer`, `delverOnly` or `backendOnly`, carrying
  Delver's `FunctionSource` and the backend's bounds. Both inputs are
  recomputable, so this is facts, not interpretation (invariant 3). Totality is
  deliberate: the `agree` rows are what make a false-positive rate measurable
  later.
- **Adjudication is a separate pass over those rows, never part of the join.**
  Ranking a disagreement needs a heuristic, and a heuristic will be wrong. Kept
  separate, a wrong heuristic is rewritten and the corpus survives; folded into
  the join, it costs the corpus.
- **A backend that cannot enumerate its functions does not advertise the
  capability.** No code branches on `backendId` to decide behavior
  (invariant 6). Reconciliation is then absent for that backend, which is a
  different claim from "the backends agree".
- **`UNDEF_<rva>`, not `func_0x<absolute>`.** The worker rewrites the fallback
  form to an image-relative placeholder, and keeps it lexically distinct from
  `SUB_`. The distinction is real information — no function was recovered at
  that address by the backend that produced the text — and flattening it to
  `SUB_` would present a non-function as a function, the confident-wrong
  failure this project ranks worst. Both rewrites leave an address below the
  image base alone, because it is not an RVA.

## Consequences

"Who did better" stops being a global score and becomes a per-boundary,
per-backend question. That is the answerable form: *"Ghidra misses 31
exception-directory thunks IDA finds"* is actionable in a way that *"IDA scored
94%"* is not.

**Provenance ranks a disagreement; it does not settle one.** The first run of
this design, against `Auto-updater.exe` with IDA 9.1 as the second party, said
640 boundaries were `delverOnly` from `ExceptionDirectory` — the most
authoritative source there is. 638 of them were Delver being wrong: chained
`RUNTIME_FUNCTION` fragments recovered as function starts (defect-audit,
2026-08-30). A vouched source was not evidence that the backend had missed
something; it was evidence of a systematic fault in how Delver reads that
source, which is exactly what a source everything trusts is able to hide.

So an adjudication pass must not read `is_vouched()` as "Delver wins". What
provenance actually buys is a *shape* to investigate: a disagreement concentrated
in one source, at one classification, is a claim about a parser, while one
scattered across sources is a claim about individual addresses. The 638 were
legible because they were uniform. This is why adjudication stays out of the
join — the heuristic in the first draft of this ADR was wrong on first contact
with real data, and correcting it cost nothing but this paragraph.

**The rule the pass actually uses is containment, not provenance.** It asks a
question about the other side's answer rather than about our own confidence:
does the disputed address fall strictly inside a function the other side already
has? Inside is a boundary dispute — both sides agree the bytes are code and
disagree about where one function ends. Outside is a coverage gap. Measured
across four images once the fragment defect was fixed, every remaining
exception-directory disagreement fell outside any backend function, 23 of 23,
against 638 of 640 falling inside beforehand. Containment separated the two
populations where provenance did not separate them at all. Source concentration
survives as an advisory signal on top, because it is what made the fragment
defect legible in the first place.

`FunctionSource::Authored` is interpretation while the other six sources are
facts, and both live in the same `Vec<Function>`. The reconciliation carries the
source tag through rather than filtering, so a later adjudication or repair pass
can decide what authored boundaries mean without re-deriving them. This is the
one place the design touches invariant 3, and it is why this ADR exists.

Repairing the disagreement — feeding Delver's vouched boundaries to a backend so
`UNDEF_` becomes `SUB_` — is deliberately **not** decided here. It ports onto
[0013](0013-accepted-semantics-as-decompilation-input.md)'s snapshot machinery
when it happens, and it stays gated until the reconciliation has been read on
real samples. Pushing an unvalidated function set makes a decompiler emit
confident wrong C.

## Alternatives

| Option | Why not |
| --- | --- |
| Pairwise comparison between every backend | The obvious reading of "compare them and see who did better". N² relationships, no tiebreak that is not arbitrary, and every new backend edits existing comparisons |
| Delver's set is authoritative; disagreement is a backend defect | Simplest, and matches the facts store being Delver's. It makes a `LinearSweep` boundary — which the source itself comments as "Nothing references it — this is a guess" — outrank a real analyzer |
| Rewrite `func_0x<absolute>` to `SUB_<rva>` | One line, and it makes the pane look consistent. It also makes a call into an address no tool recovered a function at indistinguishable from a call to a recovered function |
| Filter `Authored` boundaries out of the reconciliation | Keeps the fact/interpretation line crisp. It also hides the disagreements an analyst most wants to see — the ones where they already overruled a derivation |
