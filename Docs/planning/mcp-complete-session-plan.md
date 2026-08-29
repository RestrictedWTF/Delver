# Complete MCP Reverse-Engineering Session

This plan defines what remains after the MCP transport works. The transport is
not the product outcome: a complete session must let an agent inspect evidence,
navigate relationships, retain provisional conclusions, improve the analysis,
and resume or export the investigation without losing provenance.

The current comparison baseline is
[`mrexodia/ida-pro-mcp`](https://github.com/mrexodia/ida-pro-mcp). It is a useful
breadth reference, not a design template. Delver keeps its stricter content-hash
identity, bounded results, untrusted-data labelling, local authorization, and
proposal/review model rather than copying direct mutation or unrestricted
scripting into the default capability set.

## Completion levels

These claims are deliberately separate:

1. **MCP transport complete** — supported clients can discover and call the
   canonical dispatcher with equivalent results, cancellation, routing, and
   measured overhead.
2. **Human-supervised static session complete** — against an already-open
   project, an agent can investigate and leave attributed proposals and findings
   for human review.
3. **Static reverse-engineering session complete** — the agent can also inspect
   raw data, search code and bytes, traverse control flow, refine types, and
   request guarded analysis corrections within the supported PE/x86/x64 scope.
4. **Autonomous or dynamic session complete** — durable work scheduling,
   agent-managed targets, runtime memory, and debugging are available. This is
   later work and must not block the static session.

## Current baseline

Thirty-five canonical capabilities cover session state, focus, image facts,
functions, raw byte reads, byte and instruction search, address conversion,
signature generation and persistence, basic blocks, function profiles, call
graphs and bounded call paths, observed globals and their static accesses,
disassembly, decompilation, xrefs, strings,
imports, exports, accepted interpretation, review-only rename/comment/tag,
data-type/function-prototype and function-bounds proposals, and evidence-backed
provisional findings. Every
result carries project identity, provenance, completeness, and bounded
pagination where the underlying operation supports it.

The native stdio adapter, root-v1 routing, one-shot local authorization, private
DTP connection, cancellation, reconnect-after-transport-failure, and generated
tool schemas are implemented. What remains before calling the transport complete
is real-client and real-binary conformance, progress/list-change events, and
latency measurement.

## Ordered capability work

### S1 — Retain the investigation

The first agent writes are implemented as provisional, validation-atomic
batches:

- `delver_propose_rename`
- `delver_propose_comment`
- `delver_propose_tag`
- `delver_report_finding`

They require model attribution, work against attached and offline projects, and
do not change the accepted materialized interpretation. Their MCP annotations
are non-read-only, non-destructive, and non-idempotent.

Rename, comment, and tag proposals use the existing append-only interpretation
log and never enter the materialized picture before review. Findings use a
dedicated durable model with severity, confidence, described image ranges,
caller/report-call provenance, and lifecycle; they are not encoded as comments.
They persist immediately in named projects and participate in the Save flow for
untitled projects.

The Review view now groups pending interpretation proposals and findings, offers
human Accept/Reject actions, and publishes proposal locations and finding ranges
through the focus bus. Finding decisions are separate append-only records in
portable-project schema v6; neither acceptance nor rejection rewrites the model's
claim.

Portable-project schema v6 also retains each successful project-bound dispatcher
request/result envelope. Finding ranges can cite earlier results by `callId`;
references are validated against the same target revision and appear beneath the
range in Review. Selecting one opens its complete retained request/result in a
read-only JSON editor. Group-level Accept All/Reject All now submit one validation-atomic domain
batch per queue. Graph-path evidence in Review, and threshold-based review
policy, remain.

**Exit:** an external agent proposes a validation-atomic batch of interpretations
and a finding; the analyst can inspect its cited bytes and accept or reject it.
This exit is complete for the static-session baseline.

### S2 — Read the bytes, not just their rendering

The first four vertical slices are implemented: `delver_read_bytes` provides
bounded image-RVA and raw-file-offset reads plus exact little-endian integer
views over the existing provider binary-frame protocol, and
`delver_convert_address` maps RVA, absolute VA, and raw file offsets from live or
persisted section metadata without pretending headers or virtual zero-fill have
raw backing. `delver_search_bytes` adds cursor-bound exact/nibble-wildcard scans
over selected raw-backed image sections, including complete negative results.
`delver_make_signature` grows instruction-aligned patterns and proves them over
function, executable-section, or image scope. Its relocation-stable mode uses
decoder and PE relocation metadata, reports every wildcard and covered RVA, and
can return a separately proven incoming-xref-site signature when target bytes
are ambiguous. Proven primary or xref-site results can be named through their
retained source call and restored offline from the per-revision schema-v6
signature table. Adaptive selection from raw historical bytes remains
fail-closed until those samples can be retained or attached. A conservative
retained-evidence mode is implemented: the same relocation-masked primary
pattern must have an exact one-match proof saved for the same function identity
in an earlier revision and remain exactly unique in the current revision. It
never reads a historical source path and makes no claim for revisions without
saved proof.
Exact mnemonic and formatted operand-text instruction search is implemented.
Structured immediate/constant search and structured data/global reads remain.

The listing and Signatures-view generator action exposes all three policies in
a policy picker, with relocation-stable first and recommended. Cross-revision
results name and count the retained earlier-revision proofs beside the pattern;
the UI rejects inconsistent proof counts or patterns before offering copy/save.
Earlier Revision Scan additionally binds regeneration to its exact source
revision/signature ids, and migration acceptance revalidates that binding from
the retained generation result before transferring annotations.

Add bounded, batch-first operations for:

- raw bytes and typed integers;
- string/data/global reads at an address;
- RVA, VA, and file-offset conversion (`done`);
- byte patterns with wildcards (`done`);
- instruction-aware function signatures (`done` for unique-now, relocation-stable, and retained-proof cross-revision stability; adaptive selection from historical bytes remains);
- instruction, immediate, constant, regex, and later YARA searches.

Disassembly results should optionally include encoded bytes. Searches that exceed
an interactive budget become cancellable background operations rather than
returning an unrecoverable partial scan.

**Exit:** every low-level claim can cite retrievable bytes, and a negative search
claim is possible only after a complete scan.

### S3 — Expose program structure

Three vertical slices are implemented. `delver_basic_blocks` returns bounded,
provider-derived half-open blocks and typed direct CFG edges for one detected
function; truncation remains explicit and edges never point outside the returned
block set. `delver_function_profile` sizes one function — instruction, block,
edge, call-site, and return counts — so a model can judge it before reading it.
`delver_call_graph` returns its bounded direct callers and callees, cited
function-relatively, paging both as one ordered sequence.

All three derive from retained facts — the bidirectional xref table, detected
function bounds, and instruction-flow records — rather than decoding again, and
all three are batch answers rather than something a model reconstructs from
hundreds of single-address xref calls.

Two honesty constraints came out of the slice and now bind the rest of S3. An
indirect call site is returned as evidence and forces `partial` on its own, so a
direct call graph can never be read as the complete set of what a function
calls; this required splitting `FlowKind::Indirect` into `IndirectCall` and
`IndirectBranch`, since a jump-table dispatch is not an outgoing call. And an
extent inferred from the contiguous decoded run — the only extent available for
the last function in a PE — is reported as inferred, so `bounded` keeps meaning
*recorded*.

Indirect targets are resolved where the evidence allows it. A `call [rip+X]`
whose memory operand names an IAT slot, and a direct call landing on a
one-instruction `jmp [IAT]` thunk, both resolve to the imported API with
`method` and `confidence: exact`. Ambiguity fails closed. Vtable- and
dataflow-derived targets remain, and land on the `probable` tier.

`delver_call_paths` closes the exit criterion: bounded source-to-sink paths
carrying every intermediate call site, over a function or an import-slot sink,
with edges derived on demand rather than by materializing the graph. A negative
result is a claim about the program only when the search was exhausted, no
depth/visit/path limit fired, and no unresolved indirect site sat on the
frontier.

**Exit:** met.

The original exit statement, now met: *an agent can trace a source-to-sink path
and return the complete ordered address evidence without materializing the
entire program graph.*

### S4 — Refine semantics

Add globals, prototypes, local variables, stack frames, enums, structures, and
type propagation. Agent-authored semantic changes remain proposals. Accepted
type changes invalidate affected saved pseudocode and summaries, then expose the
new decompiler provenance.

Prefer deterministic compiler metadata before asking an agent to infer the same
relationships. The open
[compiler-metadata semantic-recovery proposal](ideas/compiler-metadata-semantic-recovery.md)
starts with MSVC RTTI/vtables and ranks adjacent symbol, unwind, prototype,
layout, and runtime-metadata enrichers. It remains a proposal until its corpus
spike demonstrates precise recovery and honest degradation.

The globals and semantic-proposal slices are implemented. `delver_list_globals` inventories
non-executable addresses actually named by retained data references, and
`delver_global_accesses` returns their referencing instructions and containing
functions. These are explicitly observed candidates, not source declarations:
no type, size, read/write mode, register-derived pointer, or runtime-only access
is inferred, and both tools remain partial after paging ends so absence cannot be
misread as proof. This is the stable address substrate for the type work that
follows. `delver_propose_type` then adds validation-atomic, attributed data-type
and exact-function-entry prototype proposals to the append-only interpretation
log and the existing Review workflow. Accepted declarations persist and
materialize independently. Decompilation now carries a versioned content-wide
semantic snapshot: memory and portable-project caches reject any different
snapshot, while PyGhidra applies the accepted declarations inside a rollback
transaction before producing replacement output. This is correct but
conservative; narrowing each snapshot to the globals and callees one function
actually consumed remains the next slice. The legacy headless backend fails
closed when accepted semantics are present. The open pseudocode pane
re-decompiles when an accepted data type or prototype lands for the bytes it is
showing, so an acceptance changes the C in front of the analyst rather than
waiting for the next request.

Composites close the structure half of the exit. An anchor may now name a type
instead of a place — `{ kind: 'type', contentHash, name }` beside the image
anchor — and `EditOp.CompositeType` records one named layout as canonical JSON
with fields at explicit offsets ([ADR 0014](../history/adr/0014-type-anchors-for-authored-composites.md)).
It reuses the whole edit log unchanged: propose, accept in Review, compensate,
revert by author, export and import, and no `.delverdb` migration, because that
machinery keys on `(anchor, op)` and never on an address. The semantic snapshot
moved to `schemaVersion: 2` and applies its `composites` array before `dataTypes`
and `functionPrototypes`, so a declaration can name a struct the same snapshot
introduced; both decoders accept v1 and normalize it up to v2, which is what
keeps pseudocode saved before composites existed from comparing as stale. The
worker defines the structures in two passes — every name registered as an empty
`StructureDataType` with packing disabled, then fields placed at the offsets they
were authored with — so mutually referencing structs resolve whichever direction
the reference runs, still inside the transaction that is always rolled back.
`delver_propose_type` takes `target: "composite"` with `name`/`size`/`fields`
instead of `address`/`declaration`, through a `oneOf` schema so a composite
cannot be sent with an address that would be silently ignored.

**Exit:** met.

The original exit statement, now met: *an agent proposes a structure and function
signature, a human accepts them, and a subsequent decompilation reflects the
accepted types.* Both go in through `delver_propose_type` as review-only
proposals, Review accepts them, both enter the versioned snapshot, PyGhidra
defines the composites and then applies the declarations before decompiling, and
the snapshot is part of decompilation identity — so no memory or portable cache
can serve text produced against the previous type model.

Four limits remain, all visible in the code.

- **The snapshot is content-wide, not a dependency graph.** Every accepted
  declaration for a content hash is carried into every request for those bytes,
  so accepting one type invalidates every saved function in the image. It can
  never serve pseudocode built against different semantics, which is the property
  worth having first, but it discards more than it must.
- **Only PyGhidra applies accepted semantics.** The headless backend has no
  route for declarations, so a request carrying them is answered against the
  empty snapshot and marked `semanticsIgnored` — correct C for the bytes, openly
  not reflecting the accepted type model, and reported `partial` to an agent.
  Headless users keep their pseudocode and lose only the type awareness. What is
  still missing is headless actually applying the declarations.
- **Only `struct`.** `kind` is a `struct`-only allow-list at three layers: the
  dispatcher writes it, the result decoder requires it, and the worker's
  `COMPOSITE_KINDS` refuses anything else rather than laying out storage the
  analyst never described. The tool exposes no `kind` at all, so a union or an
  enum cannot be proposed in the first place.
- **The reload is coarse, by construction.** Accepting a composite reloads the
  open pane like any other semantic edit, because whether *this* function uses
  that layout is not knowable without the dependency graph the snapshot
  deliberately does not have. Correct and wasteful, in the same direction as the
  content-wide snapshot itself.

Local variables, stack frames, and type propagation are untouched. Nothing
invalidates *summaries* because no durable summary store exists yet.

### S5 — Correct analysis safely

The phase covers capability-gated operations to define or undefine code, data,
and functions; adjust function bounds; force reanalysis/recompilation; and patch
bytes or assembly. These change facts or target state rather than interpretation,
so they need a separate unsafe profile, explicit confirmation, before/after bytes,
and an auditable recovery story.

Arbitrary Python execution is not part of the default MCP surface. Prefer
bounded recipes or a separately enabled and separately authorized scripting
profile.

**Function starts are done.** An authored correction is an addition to, or a
suppression within, the *function seed set*, and analysis re-derives every fact
from the image bytes plus the corrected seeds — nothing is written into the fact
store ([ADR 0015](../history/adr/0015-authored-corrections-re-derive-facts.md)).
`EditOp.FunctionBounds` carries the decision as canonical JSON on an image
anchor, so propose, accept, compensate, revert-by-author, `.delverlog` export and
import all reached it unchanged; the JSONL validator had to be taught the op,
which fails closed on the whole log for one it does not know.
`delver_propose_function` is the agent route — review-only `define`/`undefine`,
validation-atomic, with a `define` required to land in mapped executable memory
and an `undefine` deliberately checked against nothing, so an analyst can
pre-empt a seed the next analysis is about to invent. In Rust,
`FunctionSource::Authored` outranks every derived source, a correction set applies
whole or not at all, and `analyze` and `analyze_corrected` are one implementation
so corrected facts stay comparable to uncorrected ones.
`analysis/setCorrections` re-derives an open image without a provider round trip
and reports the function count before and after; the session service pushes the
accepted set during open, before any caller sees the session.

**Exit:** met, for function starts only.

The exit statement — *a user can approve one disclosed correction, inspect its
exact effect, and recover the prior state* — is met by four distinct pieces:

- **Approve.** A correction arrives as a `proposed` edit and is accepted or
  rejected in Review like any other, with the row labelled by what it will do
  rather than by its JSON. A proposal contributes an address to review and
  nothing to the derivation, because `functionCorrectionsFor` reads the
  materialized view.
- **Disclosed.** `analysis/setCorrections` returns `function_count_before`,
  `function_count`, `instruction_count`, and `corrections_applied` — the effect
  stated in the only terms the server can state it.
- **Exact effect.** The facts are re-derived, not patched: instructions, function
  starts, basic blocks, the xref table, and the listing index all come from
  `derive`, which is the single place the analysis and the listing are produced
  together, so they cannot drift.
- **Recover.** Two routes. An `undefine` withdraws a start the analysis invented,
  and compensation or revert-by-author withdraws the correction itself — the
  compensation is an accepted edit, so it re-derives on the spot, and because
  nothing was mutated the previous facts return exactly.

What S5 still does not have, all verified absent rather than assumed:

- **Undefining *code* and *data*, as distinct from undefining a function.**
  `Undefine` withdraws a function start only; the instructions stay in the index
  and inbound call xrefs stay in the table, because a call is still a fact about
  the image. There is no operation that says "these bytes are not code" or "these
  bytes are data", and no edit op for one.
- **Adjusting the bounds of an existing function, as an operation.** A `define`
  carrying an explicit exclusive end does pin an extent at an address detection
  already found — that much works, and suppresses sweep guesses inside the range.
  What does not exist is an operation whose subject is an existing function:
  moving a start is an `undefine` plus a `define` that the log records as two
  unrelated corrections at two addresses, and nothing ties them together.
- **Forced reanalysis.** `analysis/setCorrections` is pushed by the session
  service — at open, and when an accepted `functionBounds` edit lands. No
  capability lets a caller ask for a re-derivation, so there is no way to say
  "analyse this again" without authoring a correction. Forced *recompilation* is
  the one piece of this bullet that exists: `delver_decompile` takes
  `refresh: true`, which bypasses the cache and re-runs the backend.
- **Byte and assembly patching.** Nothing in the correction path reads or
  modifies target bytes, and there is no write path to a target at all. ADR 0015
  excludes it explicitly: a patch changes the bytes, so facts derived from them
  are facts about something the sample no longer is. It needs its own decision,
  its own unsafe profile and confirmation, before-and-after bytes, and its own
  recovery story, and must not be bolted onto `FunctionCorrection` because the
  two look superficially alike.

Every change to the correction set also costs a full re-analysis of the image.
That is acceptable now and would force incremental re-derivation on an image
where it reads as a stall.

### S6 — Make investigations durable

Persist investigations, work items, findings, evidence, summaries, and tool-call
records. Add resumable budgets, artifact/report export, and notebooks. Oversized
pseudocode and exports must be retrievable through lossless chunks or durable
artifacts rather than prefix truncation.

**Exit:** a large investigation resumes from unresolved work without replaying
chat history and exports a report whose claims link back to evidence.

## Transport closure

Before declaring P3b complete:

1. Run the same attached-target and offline-project workflow through Codex,
   Claude Code, Kimi, Cursor, and a minimal reference client.
2. Require normalized direct-dispatcher, DTP, and MCP results to match.
3. Exercise cold decompilation, cancellation, timeout, process death, reconnect,
   root rotation, and ambiguous windows.
4. Measure the documented p50/p95 stages and test with the MCP Inspector.
5. Add operation progress and capability-change events when DTP can observe
   them; do not synthesize events in the adapter.
6. Publish output schemas for structured results.

Streamable HTTP and read-only MCP resources are useful later conveniences, not
requirements for a complete local static session.

## Current result-loss and offline gaps

- ~~Long pseudocode is prefix-truncated without a continuation cursor.~~ Fixed: `delver_decompile` pages on line boundaries and returns `nextCursor`, `firstLine`, and `totalLines`, with `lineMappings` scoped to the lines a page actually carries. The cursor is bound to the exact text, so continuing into a re-decompiled function is refused rather than splicing two bodies together under one set of line numbers.
- ~~A capped string scan can be permanently partial; paging cannot reach strings that were never extracted.~~ Fixed wherever the sample is attached. Scanning the 35 largest binaries in a stock `C:\Windows\System32` found **9 at the 200,000-string cap**, `mshtml.dll` and a 228 MB `MRT.exe` among them, so the bound was reachable on ordinary system binaries rather than only on hostile ones. `analysis/scanStrings` re-scans a bounded window of the image on demand, and `delver_list_strings`/`delver_search_strings` walk in two phases: an index into the list retained when the image was analysed, then a position in the image once past it, with the cursor carrying which phase it is in. `mshtml.dll` now yields 281,537 strings and `MRT.exe` 5,736,204, the latter over 28 continuations. **The offline case is unchanged and still refuses:** the retained list is all a project without its sample has, so it answers that some strings were never extracted and no cursor will reach them. One residual hole, deliberate: a page walk assumes sections are disjoint in virtual address, so a hostile file whose sections genuinely *overlap* can hide strings below a cursor. The whole-image scan is unaffected.
- DTP applies one fixed 60-second deadline even though live decompilation has no
  fixed latency claim.
- Portable snapshots retain the cross-reference table from schema 8 (ADR 0012),
  so an offline project answers `delver_xrefs_to` and `delver_xrefs_from`;
  a project saved without one refuses rather than answering zero. Listing rows
  are still not retained, so `delver_disassemble` and the other byte-decoding
  tools still need the original sample.
- The decompiled-function batch limit exists in the contract, but the current
  capability accepts only one function.

Fix these as part of S2/S6 and transport closure rather than treating an honest
`partial` result as a complete investigation primitive.
