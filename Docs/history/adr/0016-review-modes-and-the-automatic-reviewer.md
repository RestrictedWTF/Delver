# 0016 — Automatic review is recorded, never simulated

**Status:** accepted
**Date:** 2026-08-29
**Affects:** `CLAUDE.md` invariant 5 ·
[0006](0006-proposal-resolution-in-the-edit-log.md) ·
[`architecture/ai-analyst.md`](../../architecture/ai-analyst.md) ·
`services/delver/common/delverReviewPolicy.ts` ·
`services/delver/common/delverInterpretationService.ts` (`propose`) ·
`services/delver/common/delverProjectService.ts` (`reportFindings`) ·
`services/delver/common/delverFindingReport.ts` ·
`contrib/delverAI/browser/delverReview.contribution.ts`

## Context

Every model-authored edit in Delver lands as a *proposal*: visible in the log,
absent from the picture, waiting for a human. That is the right default and it
is not free. An analyst driving an agent across a large binary can face
hundreds of pending renames and comments, and clicking accept four hundred
times is not review — it is a formality that *looks* like review, which is
worse than not having asked.

So there is a real case for a mode that accepts a model's work as it arrives.
The analyst who wants it is not being careless; they intend to audit in bulk
afterwards, or they are sweeping a sample they already trust.

The hazard is not that mode. The hazard is what the mode is allowed to *say*.
An acceptance recorded like any other would make the log, the review view, and
an exported report all state that a proposal was accepted — with no way, at any
of those three surfaces, to tell that from a person having agreed. Findings are
where that bites hardest: a finding is a conclusion, and
[the report](../../planning/mcp-complete-session-plan.md) exists to be handed to
someone who was not there and cannot check the sample. "Accepted" reading as
"a person agreed" when nobody looked is a false claim about the binary, which
this project ranks above a crash.

## Decision

**A review mode selects whether proposals wait. It never selects what the
record says.**

`delver.review.mode` is `manual` (default) or `auto`, registered as a
`RESOURCE`-scoped setting so a workspace can override a permissive user
default and not the reverse. An unrecognised value settles to `manual`: the
failure directions are not symmetric, and a typo in settings must not be a
route to the permissive mode.

Under `auto`:

- **A proposal is still appended as a proposal**, and then decided by a second,
  separate append. It is never written straight to `accepted`. The two-record
  form keeps "a model claimed this" and "a policy accepted it" as separate
  facts, linked by `resolves`, which is exactly the structure
  [ADR 0006](0006-proposal-resolution-in-the-edit-log.md) already defined for
  human review. Both appends happen inside one queued operation, so no reader
  observes the undecided intermediate state.
- **The reviewer is `{ kind: 'rule', id: 'delver.review.mode' }`.** The author
  kinds already included `rule`; this is what it is for. Reusing the local
  human author would have been one line shorter and would have put a person's
  name against work they never saw.
- **Findings are decided the same way** — a real `IDelverFindingDecision`
  appended after the fact, authored by the rule. The finding's own `status`
  stays `proposed`, because that field records what the model claimed, and the
  decision records what happened to it.
- **The mode is read per proposal, not cached.** Turning review back on takes
  effect on the next proposal rather than at the next reload.

And every surface that reports a decision distinguishes the two:

- The **report** gives automatically accepted findings their own heading —
  "Accepted automatically — no human reviewed these" — rather than a variant of
  "Accepted", states the policy in the summary block where a reader who skims
  and stops will see it, and renders the per-finding review line as "accepted
  automatically by `delver.review.mode` … — no human reviewed this".
- **`delver_capabilities`** reports `reviewMode`, because under `auto` a
  proposal is not provisional and an agent telling the analyst "I have proposed
  this for your review" would be describing something that already happened
  without them.

## Consequences

The log grows two records per proposal instead of one under `auto`. That is the
price of the distinction and it is worth paying; a log that cannot say who
decided something is not an audit trail.

Automatic acceptance applies to corrections too, including data ranges, and
each accepted correction re-derives the image. A `data` range that is wrong can
erase most of the function list until an analyst compensates it, and under
`auto` nobody is asked first. This is a real cost of the mode rather than a
defect in it, and the honest mitigation is that the correction is recorded, the
re-derivation is announced, and a refused set is now surfaced rather than
swallowed.

The setting is not stored in the `.delverdb`. A project therefore does not
carry the policy it was analysed under, and a report is the only artifact that
says so — it says it because the decisions themselves carry their author, not
because the mode was persisted. Storing the mode per project was considered and
deferred: it needs a schema migration, and the decision records already answer
the question the persisted mode would have answered.

## Alternatives

**Write proposals straight to `accepted` under `auto`.** One append instead of
two, and the log then contains an accepted model-authored edit with no account
of how it became accepted — indistinguishable from an analyst having agreed.
Rejected: it destroys the only evidence that nobody read it.

**Attribute the acceptance to the local human author.** Simplest of all, and a
lie. Rejected.

**Restrict `auto` to annotations, leaving types, corrections, and findings to a
human.** Safer, and it was offered. The analyst asked for all of it, including
findings, which is a legitimate choice for someone who intends to audit in
bulk. The safety this ADR owes them is not a narrower mode but an honest
record, which is what the rest of it is about.

**Keep the mode session-only so it cannot persist.** Rejected as too weak for
the actual workflow — an agent sweep spans reloads — and unnecessary once the
record is honest.
