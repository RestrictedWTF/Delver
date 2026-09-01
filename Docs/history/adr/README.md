# Architecture Decision Records

One page per decision that is **expensive to reverse**. Not every choice — if
it's cheap to change, just change it.

## Rules

1. **Numbered and append-only.** `NNNN-short-title.md`.
2. **Never edit an accepted ADR.** When you change your mind, write a new one
   that supersedes it and add a `Superseded by` line to the old one. The value
   is in seeing what you believed then and what changed.
3. **One page.** If it needs more, the detail belongs in an architecture doc
   and the ADR links to it.
4. The docs in [`../../architecture/`](../../architecture/) are the *current standing design*. ADRs
   record movement away from them.

## Worth an ADR

Disassembler engine · decompiler backend and pinned version · storage format ·
wire protocol and framing · scripting language and binding · sandboxing model ·
anything that changes an invariant in the root `CLAUDE.md`.

## Not worth an ADR

View layout · naming · which crate a function lives in · anything a lint rule
already enforces.

## Backfill

The initial design decisions live in the architecture docs, not in ADRs — that's
fine, they were made together. Backfill an ADR only when one of them comes up
for reconsideration, and let the ADR carry the *change*, not the history.

## Index

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-wire-protocol-framing-and-encoding.md) | Wire protocol: framing, number encoding, and errors | accepted | 2026-08-06 |
| [0002](0002-wire-types-separate-from-domain-types.md) | Wire types separate from domain types | accepted | 2026-08-06 |
| [0003](0003-unsafe-code-in-transport-listener.md) | Unsafe code in the transport listener | superseded by 0010 | 2026-08-07 |
| [0004](0004-interpretation-store-location.md) | Where authored interpretation is stored | superseded by 0005 | 2026-08-08 |
| [0005](0005-portable-project-database.md) | Portable project database and session save lifecycle | accepted | 2026-08-11 |
| [0006](0006-proposal-resolution-in-the-edit-log.md) | Accepting and rejecting proposals in an append-only log | accepted | 2026-08-19 |
| [0007](0007-workspace-editor-over-sidebar-container.md) | Delver surfaces live in a workspace editor, not a sidebar container | accepted | 2026-08-26 |
| [0008](0008-one-session-per-open-target.md) | One session per open target | accepted | 2026-08-26 |
| [0009](0009-unified-address-ordered-listing.md) | One address-ordered listing over the whole image | accepted | 2026-08-26 |
| [0010](0010-unsafe-code-in-os-security-modules.md) | Unsafe code in the OS security modules | accepted | 2026-08-27 |
| [0011](0011-append-only-named-signatures.md) | Named signatures are append-only and authored | accepted | 2026-08-27 |
| [0012](0012-retained-xref-table-in-portable-projects.md) | The xref table is retained in the project, as a table | accepted | 2026-08-28 |
| [0013](0013-accepted-semantics-as-decompilation-input.md) | Accepted interpretation is an input to decompilation, not backend state | accepted | 2026-08-28 |
| [0014](0014-type-anchors-for-authored-composites.md) | An anchor may name a type instead of a place | accepted | 2026-08-28 |
| [0015](0015-authored-corrections-re-derive-facts.md) | An authored correction changes what analysis derives from, not what it derived | accepted | 2026-08-28 |
| [0016](0016-review-modes-and-the-automatic-reviewer.md) | Automatic review is recorded, never simulated | accepted | 2026-08-29 |
| [0017](0017-cross-backend-function-handshake.md) | One reference frame for function boundaries, and honest placeholders | accepted | 2026-08-30 |
| [0018](0018-one-moment-taxonomy.md) | One Moment taxonomy, and the epoch carries the position | accepted | 2026-08-31 |
| [0019](0019-vtable-slice-bounded-by-recovered-functions.md) | A vtable slot is a recovered function, not an executable address | accepted | 2026-08-31 |
| [0020](0020-the-model-drives-the-workbench-to-verify-behaviour.md) | The model drives the workbench to verify behaviour; the human judges how it looks | accepted | 2026-09-01 |
| [0021](0021-the-provider-issues-the-moment.md) | The provider issues the Moment, and every read carries it | proposed | 2026-09-01 |
