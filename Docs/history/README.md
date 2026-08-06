# History

**What we used to think, and why it changed.** Append-only. Nothing in this
folder gets rewritten to match current reality — that's the entire point of it.

| Doc | What it is |
| --- | --- |
| [original-vision.md](original-vision.md) | The product vision as originally written, before any implementation review. Preserved verbatim. |
| [critique-and-direction.md](critique-and-direction.md) | The review of that vision: what to keep (B-items), what breaks, what was missing (G-items). The standing decisions it produced have been folded into [`../architecture/`](../architecture/). |
| [adr/](adr/) | Architecture Decision Records — one page per expensive-to-reverse decision |
| [plans/](plans/) | Executed phase plans, with a record of where execution diverged from intention |

## Why keep superseded thinking

Two reasons, both practical:

- **Revisiting a decision needs the original reasoning**, including what wasn't
  known at the time. Without it, a revisit re-derives from scratch and usually
  lands somewhere arbitrary.
- **Rejected options stop coming back.** An idea that was considered and
  discarded will resurface every six months unless the reason is written down
  somewhere findable.

## Rules

1. Never edit an accepted ADR. Write a new one that supersedes it, and add a
   `Superseded by` line to the old one.
2. Never "correct" `original-vision.md` to match the current design. The gap
   between it and [`../architecture/`](../architecture/) is information.
3. `critique-and-direction.md` is a point-in-time review. If its reasoning stops
   holding, that's an ADR, not an edit.
4. An archived plan keeps its body verbatim. Completion status and divergences
   go in a banner at the top — see [plans/README.md](plans/README.md).
