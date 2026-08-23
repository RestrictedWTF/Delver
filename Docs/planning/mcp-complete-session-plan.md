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

Twenty-one canonical capabilities cover session state, focus, image facts,
functions, raw byte reads, disassembly, decompilation, xrefs, strings, imports, exports,
accepted interpretation, review-only rename/comment/tag proposals, and
evidence-backed provisional findings. Every
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
read-only JSON editor. Graph-path evidence and batch review operations remain.

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
signature table. Cross-revision selection remains fail-closed until historical
sample bytes can be retained or attached. Instruction search and structured
data/global reads remain.

Add bounded, batch-first operations for:

- raw bytes and typed integers;
- string/data/global reads at an address;
- RVA, VA, and file-offset conversion (`done`);
- byte patterns with wildcards (`done`);
- instruction-aware function signatures (`done` for unique-now and relocation-stable; cross-revision byte retention remains);
- instruction, immediate, constant, regex, and later YARA searches.

Disassembly results should optionally include encoded bytes. Searches that exceed
an interactive budget become cancellable background operations rather than
returning an unrecoverable partial scan.

**Exit:** every low-level claim can cite retrievable bytes, and a negative search
claim is possible only after a complete scan.

### S3 — Expose program structure

Add function profiles, callers/callees, basic blocks, CFG edges, bounded call
graphs, path queries, and confidence-bearing indirect targets. Prefer summary or
batch operations over forcing the model to reconstruct a function graph through
hundreds of single-address xref calls.

**Exit:** an agent can trace a source-to-sink path and return the complete ordered
address evidence without materializing the entire program graph.

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

**Exit:** an agent proposes a structure and function signature, a human accepts
them, and a subsequent decompilation reflects the accepted types.

### S5 — Correct analysis safely

Add capability-gated operations to define or undefine code, data, and functions;
adjust function bounds; force reanalysis/recompilation; and patch bytes or
assembly. These mutate facts or target state rather than interpretation, so they
need a separate unsafe profile, explicit confirmation, before/after bytes, and
an auditable recovery story.

Arbitrary Python execution is not part of the default MCP surface. Prefer
bounded recipes or a separately enabled and separately authorized scripting
profile.

**Exit:** a user can approve one disclosed correction, inspect its exact effect,
and recover the prior state.

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

- Long pseudocode is prefix-truncated without a continuation cursor or artifact.
- A capped string scan can be permanently partial; paging cannot reach strings
  that were never extracted.
- DTP applies one fixed 60-second deadline even though live decompilation has no
  fixed latency claim.
- Portable snapshots do not currently retain listing rows or xrefs, so offline
  projects cannot answer those tools without the original sample.
- The decompiled-function batch limit exists in the contract, but the current
  capability accepts only one function.

Fix these as part of S2/S6 and transport closure rather than treating an honest
`partial` result as a complete investigation primitive.
