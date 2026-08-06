# Planning

**What gets built, when, and what state it's in.** Everything here changes
continuously — unlike [`../architecture/`](../architecture/), which changes only
when a design decision does.

| Doc | Question it answers |
| --- | --- |
| [roadmap.md](roadmap.md) | *What order, and what's deliberately not in this phase?* |
| [p1-plan.md](p1-plan.md) | Task-level plan for the phase in progress |
| [stage-d-plan.md](stage-d-plan.md) | Stage-level detail for P1 Stage D (the analysis engine) |
| [rebranding-plan.md](rebranding-plan.md) | *How do we stop being Code - OSS?* — identity, icons, packaging, theme scaffold |
| [status.md](status.md) | *Where were we?* — overwritten each session |
| [ledger.md](ledger.md) | *What exists, what's stubbed, what did we skip and why?* |
| [ideas/](ideas/) | Proposals not yet decided |

A phase plan lives here while its phase is in progress, then moves to
[`../history/plans/`](../history/plans/) with a banner recording what shipped
and where execution diverged. P0's is already there.

## The three-record split

Conflating these is the usual mistake. They answer different questions and
change at different rates — see
[`../development/working-with-ai.md`](../development/working-with-ai.md) §2.

- **status.md** is for cold starts. Overwrite it. One write at the end of a
  session turns the next one warm.
- **ledger.md** is for skipping and falling back. The "deliberately not done"
  column is the load-bearing one.
- **[`../history/adr/`](../history/adr/)** is for revisiting. Append-only.

## `ideas/`

Anything proposed but not decided. One file per idea, kebab-case.

An idea graduates by one of three routes:

- **Accepted** → the substance moves into `../architecture/`, and an ADR records
  the decision if it was expensive to reverse. Delete the idea file.
- **Scheduled** → a row appears in `ledger.md` and an item in `roadmap.md`.
- **Rejected** → keep the file, add a `**Rejected:** why` line at the top. A
  rejected idea with reasoning is worth more than a deleted one, because it
  stops the same idea coming back every six months.

Ideas are not design docs. A paragraph and a sketch is enough. If it needs more
than a page, it's ready to be a proper doc.
