# 0006 — Accepting and rejecting proposals in an append-only log

**Status:** accepted
**Date:** 2026-08-19
**Affects:** [`architecture/data-model.md`](../../architecture/data-model.md) §3 ·
`platform/delver/common/interpretation.ts` ·
`services/delver/common/delverInterpretationService.ts`

## Context

`EditStatus` has carried `proposed | accepted | rejected` since the interpretation
layer was built, and proposed edits are correctly excluded from the materialized
view. What was never decided is how a proposal *stops* being pending.

The obvious move — set `status` on the proposal when a human clicks Accept —
is not available. Invariant 5 says interpretation is append-only with no silent
mutation, and that rule is what makes the log an audit trail rather than a
database with history bolted on. A review decision has to be an append.

The log already has one backward reference: `compensates`, naming earlier
accepted edits whose effects a later append undoes. The question was whether
review decisions ride on that field, get their own, or leave the edit log
entirely.

## Decision

**A review decision is an ordinary append carrying `resolves: readonly number[]`.**

```ts
// the model proposes
{ seq: 7, author: { kind: 'model', id: 'opus-5' }, op: 'rename',
  value: 'decrypt_config', status: 'proposed' }

// the analyst accepts
{ seq: 9, author: { kind: 'human', id: 'exp1007' }, op: 'rename',
  value: 'decrypt_config', status: 'accepted', resolves: [7] }
```

A proposal is **pending iff no later append resolves it**. Accepting copies the
proposal's exact anchor, op, and value; rejecting appends the same record with
`status: 'rejected'`, which records *what was declined* while having no effect on
the view.

**`resolves` is a separate field from `compensates`**, because the two describe
different events: a compensation undoes an effect the picture already had, a
resolution decides a proposal that never entered it. Collapsing them would make
"declined" and "reverted" indistinguishable in the log, and the review surface
needs to show them as the different things they are.

**The accepted edit is authored by the reviewer, not the model.** The proposal
stays in the log at the resolved sequence, so *"where did this name come from?"*
is answered by following `resolves`, while *"who decided it?"* names a person who
took responsibility. This is what makes P3c's exit condition — a human verifies
each proposal against bytes — mean something.

Appending a resolution **fails closed** on an unknown sequence, a non-proposed
target, or an already-decided proposal. Replaying a stored log is deliberately
tolerant of the same references: a log that names a sequence it does not contain
is still the user's work, and refusing to load it destroys more than it protects.

## Alternatives

| Option | Why not |
| --- | --- |
| **Mutate `status` on the proposal** | The natural shape, and it breaks invariant 5 outright. It also loses the reviewer and the moment of review, which are the audit trail's whole point. |
| **A separate `IDecision` record stream** | Cleanest conceptual split — the edit log stays purely about authored content. Rejected because it makes the JSONL log, export/import, the `.delverdb` tables, and every future merge carry a second record kind for what is structurally one more backward reference. Revisit if decisions ever need fields an edit has no room for. |
| **Reuse `compensates`** | Zero format change, and it overloads one field with two meanings that read identically in the log. A later filter cannot separate "the analyst declined this guess" from "the analyst undid their own rename". |
| **Model stays author, human recorded as `reviewedBy`** | Makes "show only AI changes" include accepted AI work, which is the more honest audit view. Rejected because an accepted edit whose author never took responsibility for it is exactly the ambiguity the attribution rule exists to remove — and the proposal is still one `resolves` hop away for anyone auditing provenance. |

## Consequences

**Makes easy**

- The review surface is a filter — `pendingProposals()` — as the data model
  always claimed it would be.
- Invalid mixed batches fail before the first append because every sequence is
  validated against the pre-batch log. Decisions remain independent append-only
  records, so a storage failure may durably commit a prefix of an otherwise valid
  batch; the caller must report that failure and reload the log before retrying.
- A rejected proposal is durable evidence. "The model suggested this and we said
  no, on this date, for this image" survives, which matters when the same guess
  comes back.

**Makes hard**

- Undoing an *acceptance* is a compensation of the accepted edit, not an
  un-resolution: the proposal stays decided and the value reverts. Correct, but
  the review surface has to say so rather than showing the proposal as pending
  again.
- Two backward-reference fields exist now. A third would mean this shape has
  outgrown itself and wants the decision stream after all.

**Would cause a revisit**

Decisions needing their own payload — a rejection reason, a confidence override,
an evidence edge that belongs to the review rather than the edit. That is the
signal to promote decisions to their own record kind.
