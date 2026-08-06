# Completed Plans

Phase plans that have been executed. **Append-only, like everything in
[`../`](../).**

The plan body stays exactly as it was written. What gets added on archival is a
banner at the top recording:

- that it's complete, and when
- what actually shipped
- **where execution diverged from the plan** — the most valuable part
- anything carried forward into the next phase

Do not edit a plan body to match what was built. The gap between intention and
outcome is the reason to keep the document at all; erasing it leaves a tidy file
that answers nothing.

| Plan | Phase | Completed |
| --- | --- | --- |
| [p0-plan.md](p0-plan.md) | P0 — walking skeleton | 2026-08-06 |

The plan for the phase currently in progress lives in
[`../../planning/`](../../planning/) and moves here when the phase closes.

## Why divergence is worth recording

Three of P0's four divergences changed the architecture spec rather than the
code — the code was right and the plan was wrong. Without the record, the next
person reads `project-structure.md`, sees flat crates, and has no idea whether
that was designed or drifted into.

A divergence that changed the spec is a decision. If it was expensive to
reverse, it should also have an [ADR](../adr/).
