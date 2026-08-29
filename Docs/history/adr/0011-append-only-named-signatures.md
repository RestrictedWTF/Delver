# 0011 — Named signatures are append-only and authored

**Status:** accepted
**Date:** 2026-08-27
**Affects:** `.delverdb` schema 6 → 7 · [0005](0005-portable-project-database.md) ·
`CLAUDE.md` invariant 5

## Context

`CLAUDE.md` invariant 5 says interpretation is append-only and always has an
author. Named signatures are interpretation: a human or an agent asserts that a
byte pattern identifies a function, and that assertion is not recomputable from
the sample.

The stored implementation did not honour this. The 2026-08-26 defect audit
(item #10) found:

- `upsertSignatures` used `ON CONFLICT(id) DO UPDATE SET name, name_key, payload,
  updated_at`. A rename or a re-proof **overwrote** the prior `pattern`,
  `wildcards`, `sourceCallId` and the entire proof block.
- `deleteSignature` issued `DELETE FROM named_signatures`.
- Neither recorded an author.

The destroyed data is load-bearing, not incidental: `historicalSignaturesFor`
and `acceptSignatureMigration` read exactly those retained proofs as the evidence
behind a `cross-revision-stable` match. Overwriting a signature therefore
corrupted the basis on which later revisions were matched — silently, and in the
only store in the system that cannot be recomputed from the sample.

The interpretation log already had the right shape for this. Nothing about
signatures justified a second, weaker one.

## Decision

`named_signatures` becomes an append-only record log, matching the interpretation
log rather than paralleling it:

`seq INTEGER PRIMARY KEY AUTOINCREMENT`, `id`, `revision_id`, `name_key`,
`payload`, `author_kind`, `author_id`, `supersedes`, `tombstone`, `recorded_at`.

- `upsertSignatures` → **`appendSignatures(projectId, signatures, author)`** —
  appends one record per changed signature, with `supersedes` naming the record it
  replaces, and appends nothing when a signature is byte-identical to the current
  record (project saves re-send the whole set).
- `deleteSignature` → **`retireSignature(projectId, contentHash, signatureId,
  author)`** — appends an authored tombstone.
- Reads resolve to the newest non-tombstoned record per id.

Schema version 6 → 7, with a forward migration that carries each v6 row over as
its signature's first record, authored `import:delverdb-v6`.

## Alternatives

| Option | Why not |
| --- | --- |
| Keep `UPDATE`, add an `author` column | Records who last wrote, not what was destroyed. `cross-revision-stable` needs the superseded proofs themselves, not their author |
| Separate `signature_history` audit table | Two sources of truth for one question, and the audit's own "one question, two implementations" theme. The log *is* the state |
| Soft-delete flag only, keep in-place update | Fixes deletion and leaves the worse half — a re-proof still overwrites the evidence a later match reads |
| Version the payload inside the existing row's JSON | Puts a log inside a column SQLite cannot index, join, or migrate |

## Consequences

- **A v7 project cannot be opened by an older build.** Migration is forward-only
  and automatic on `open()`. This is the first `.delverdb` break since 0005.
- Signature history grows monotonically. A signature renamed *n* times holds *n*
  records. Acceptable: signature counts are in the hundreds, and the interpretation
  log already grows the same way for the same reason.
- A **retired** signature no longer appears in `historicalSignaturesFor` evidence
  for its revision. Its earlier records remain on disk but no read API exposes
  them — deliberately, rather than inventing a history-reading API with no
  consumer. If one is wanted later, the data is already there.
- `IDelverProjectService.{save,rename,delete}Signature` gained an optional trailing
  `author?`, defaulting to `LOCAL_REVIEWER`. Agent-authored signatures can now be
  told apart from human ones, which invariant 5 always required and the schema
  could not previously express.
- To revisit: if signature history ever needs pruning, that is a compaction
  decision on top of this one, not a return to in-place mutation.

## Related

- [0005](0005-portable-project-database.md) — the `.delverdb` format this extends
- [0006](0006-proposal-resolution-in-the-edit-log.md) — the append-only pattern followed here
- `Docs/planning/defect-audit.md` item #10
