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
| [0003](0003-unsafe-code-in-transport-listener.md) | Unsafe code in the transport listener | accepted | 2026-08-07 |
| [0004](0004-interpretation-store-location.md) | Where authored interpretation is stored | superseded by 0005 | 2026-08-08 |
| [0005](0005-portable-project-database.md) | Portable project database and session save lifecycle | accepted | 2026-08-11 |
| [0006](0006-proposal-resolution-in-the-edit-log.md) | Accepting and rejecting proposals in an append-only log | accepted | 2026-08-19 |
| [0007](0007-workspace-editor-over-sidebar-container.md) | Delver surfaces live in a workspace editor, not a sidebar container | accepted | 2026-08-26 |
