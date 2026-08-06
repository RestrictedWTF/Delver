# Ideas

Proposals that aren't decided yet. One file per idea, kebab-case, a page at most.

An idea is not a design doc. A paragraph and a sketch is enough — if it needs
more than a page to explain, it's ready to become a proper doc in
[`../../architecture/`](../../architecture/).

## Graduating an idea

| Outcome | What happens |
| --- | --- |
| **Accepted** | Substance moves into `../../architecture/`; an ADR records it if it was expensive to reverse. Delete the idea file. |
| **Scheduled** | A row appears in [`../ledger.md`](../ledger.md) and an item in [`../roadmap.md`](../roadmap.md). |
| **Rejected** | Keep the file. Add `**Rejected:** <why>` at the top. |

Keeping rejected ideas is deliberate. An idea that was considered and discarded
resurfaces every six months unless the reasoning is written down somewhere
findable.

## Suggested shape

```markdown
# Idea title

**Status:** open | rejected | accepted → <where it went>

## What
One paragraph.

## Why it might be good
The strongest version of the argument.

## Why it might not be
The honest objection. If you can't write this, the idea isn't understood yet.

## What would settle it
The experiment, measurement, or decision that resolves it.
```
