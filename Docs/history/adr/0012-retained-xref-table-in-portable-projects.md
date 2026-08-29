# 0012 — The xref table is retained in the project, as a table

**Status:** accepted
**Date:** 2026-08-28
**Affects:** `.delverdb` schema 7 → 8 · [0005](0005-portable-project-database.md) ·
[`architecture/data-model.md`](../../architecture/data-model.md) §7 ·
[`architecture/session-persistence.md`](../../architecture/session-persistence.md) ·
`delver/server-analysis` · `platform/delver/node/delverProjectStoreService.ts` ·
`services/delver/common/delverProjectService.ts`

## Context

ADR 0005 promised a project that "remains useful when the sample is absent". A
`.delverdb` deliberately holds no sample bytes, so everything it can answer
offline is something it retained at save time. What it retains today is five
opaque JSON analysis payloads in `analysis_snapshots` — `imageInfo`,
`functions`, `imports`, `exports`, `strings` — plus `decompiled_functions`.

It does not retain the cross-reference table. `delver_xrefs_to` and
`delver_xrefs_from` are declared `requiresAttachedTarget: true`, so a project
opened without its sample answers both with `TargetNotAttached`, and every
revision saved before this is fixed stays permanently unanswerable for the one
question most analysis actually turns on: *who references this address*. Both
design docs already describe xrefs as retained — data-model.md §7's `fact_*`
group, session-persistence.md's "derived facts: functions, instructions,
strings, xrefs" — so this is drift from the standing design, not a gap anyone
chose.

The reason it cannot be fixed cheaply: **an xref lookup that answers `total: 0`
is a claim about the binary, and a wrong one is acted on.** That is this
project's P0 definition, and a real MCP trial on 2026-08-27 already paid for it.
`search_strings` reported a Python template one byte past its literal, `xrefs_to`
at that address answered `total: 0` with `completeness: "complete"`, and the
caller recovered the real reference site only by dumping bytes and finding the
literal boundary by hand (`Docs/planning/defect-audit.md`, P0 row #56). A
retention scheme that can present an incomplete table as a whole one
manufactures that same false denial by construction — this time in the store,
where no later fix to a scanner reaches it.

What we do not know: how large a retained table is in practice across a real
corpus. The size figures below are arithmetic on row width, not measurements.

## Decision

The xref table is retained in `.delverdb` as a **real, indexed SQLite table**,
and it is **queried by address rather than loaded**.

- `xrefs (revision_id, from_rva, to_rva, kind)`, primary key
  `(revision_id, from_rva, to_rva, kind)` plus an index on
  `(revision_id, to_rva, from_rva)`. This is the on-disk form of what
  `XrefTable` already does in memory: two sorted orderings, answered by binary
  search, because an xref is a row and not an object. Offline `xrefsTo` and
  `xrefsFrom` become range scans over one ordering each; the table is never
  read whole.
- Retention exports the analysis server's table through the paged
  `analysis/xrefIndex` RPC — a plain index into the table's own source
  ordering, stable because the table is built once when the image is analysed
  and never mutated, bounded at 65,536 references per page.
- The revision records whether that export ran to completion: `complete`,
  `partial`, or absent. **An incomplete table is never presented as a complete
  answer.** A bounded retention answers `partial` and says why; a revision with
  no retained table keeps answering `TargetNotAttached`, which is honest,
  rather than answering zero, which is not.

Schema version 7 → 8, forward-only, migrating on `open()`.

## Alternatives

| Option | Why not |
| --- | --- |
| A sixth opaque JSON payload in `analysis_snapshots` | Needs no migration and is the least new machinery. But a real module has millions of references, so the blob is tens of megabytes decoded into memory on every open, and any cap applied to keep that tractable is unindexable and invisible — a bounded blob answers a lookup past the bound with a confident zero |
| Retain nothing; require the sample for xrefs | Honest, and it is the status quo. It also makes ADR 0005's central promise false for the most common question asked of a binary, which is not a defensible place for the promise to fail |
| Retain only xrefs touching functions the investigation visited | Bounded, but the retention rule has to be re-applied every time the visited set grows, and outside that set "no references" is indistinguishable from "not retained" — the false denial again, now with a boundary nobody can see |
| Recompute the table offline from retained listing rows | Circular. Listing rows are not retained either, and are an order of magnitude larger than the xrefs derived from them |
| Embed the sample bytes so the table can always be rebuilt | Already rejected by [0005](0005-portable-project-database.md): it makes ordinary project sharing capable of silently distributing malware |

## Consequences

**Makes easy**

- A project opened without its sample answers `delver_xrefs_to` and
  `delver_xrefs_from` exactly, at any address, with the same paging contract as
  the live path.
- Sharing an investigation without the sample becomes genuinely useful rather
  than nominally portable: the recipient can trace callers, not just read names.
- A retained table is a queryable one, so later offline questions built on
  references — call paths, unreferenced-code review — have a store to sit on
  without a second retention decision.

**Makes hard**

- Project files grow with the binary. At roughly 50 bytes per reference in
  SQLite once the row and its secondary index are counted, a module with a
  million references costs tens of megabytes — larger than everything else in
  the file combined.
- Saving a project now costs a bounded multi-page export instead of five short
  calls, and that export can be interrupted. The `partial` state exists because
  interruption is expected, not because it is tolerated.
- **There is no downgrade path from schema 8.** Migration is forward-only, as
  in [0011](0011-append-only-named-signatures.md). This is the second
  `.delverdb` break since 0005 and the first that changes file size materially.

**Would cause a revisit**

Retaining **listing rows** is deliberately not decided here. It is the other
half of the offline gap named in
[`planning/mcp-complete-session-plan.md`](../../planning/mcp-complete-session-plan.md),
it is an order of magnitude larger than the xref table, and it needs its own
measurement and its own ADR. Nothing in this decision presumes the answer.

A measured corpus showing typical retained tables far larger than the estimate
above would force a compaction decision — a narrower row encoding, or dropping
a kind — on top of this one. It would not justify returning to a form that can
answer a bounded table as a complete one.

## Related

- [0005](0005-portable-project-database.md) — the `.delverdb` format this extends
- [0011](0011-append-only-named-signatures.md) — the schema bump with no downgrade path this follows
- `delver/delver-analysis/src/xrefs.rs` — why an xref is a row, and why the table is stored twice
- `Docs/planning/defect-audit.md` — the trial finding this is written against
