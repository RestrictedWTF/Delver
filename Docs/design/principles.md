# Design Principles

What's *additional* because Delver is a reverse engineering tool. Everything
else comes from VS Code's design language — see [README.md](README.md).

Five principles, roughly in order of how often they'll be the deciding factor.

---

## 1. Never look confident about uncertain data

The one that matters most, and the one RE tools routinely get wrong.

Delver constantly displays things that are provisional: a live read that may be
torn, a function boundary that was guessed, an annotation whose anchor only
fuzzy-matched, a name the model proposed. Rendering all of that identically to
verified fact is how an analyst reaches a wrong conclusion with full confidence —
and in this domain wrong conclusions get shipped as detection rules.

Every surface needs a visual answer to *"how much should I trust this?"*

| State | Must be distinguishable from |
| --- | --- |
| Stale (`Moment` advanced) | Current |
| Unreadable memory (`??`) | Zero bytes |
| Guessed function boundary | Confirmed (export, exception directory) |
| Fuzzy-matched anchor | Exact match |
| AI proposal | Accepted interpretation |
| Decompiler failure/timeout | Empty function |

Use one consistent vocabulary for uncertainty across all of them rather than
inventing a treatment per view. An analyst should learn it once.

This principle is also a data-model constraint — see
[`../architecture/data-model.md`](../architecture/data-model.md) §2 and §4, and
[`../architecture/target-providers.md`](../architecture/target-providers.md) §2.

## 2. Density is a feature, not a failure

An RE tool is read far more than it's clicked. Analysts scan thousands of lines
looking for one anomalous thing, and whitespace that reads as calm in a settings
page reads as *wasted screen* in a listing.

- Rows are compact. Vertical rhythm serves scanning, not breathing room.
- Columns are **tabular-aligned** — addresses, byte columns, and mnemonics must
  line up so the eye can run down them. Misaligned hex is genuinely harder to
  read, not just less tidy.
- Monospace for anything positional: addresses, bytes, disassembly, hex. Never
  for prose.
- Prefer a column to a hover. Information the analyst needs on every row should
  be *on* every row.

The tension with VS Code's default spacing is real. Resolve it toward density
inside data views, and keep workbench chrome unchanged.

## 3. Color encodes meaning, never decorates

In a view of ten thousand near-identical rows, color is the highest-bandwidth
channel available. Spending it on decoration wastes it.

- Reserve a small, fixed semantic palette: control flow, data reference, string
  reference, import/thunk, modified/patched bytes, uncertainty.
- Anything encoded by color must also be encoded by something else — a glyph, a
  column, a prefix. Roughly one in twelve analysts has a color vision deficiency,
  and this content has no redundancy to fall back on.
- Both themes, always. Dark is the default expectation in this domain, but light
  must be genuinely usable, not an afterthought.
- Never use red/green as the *only* difference between "safe" and "malicious".

## 4. Keyboard first

Analysts work at the keyboard for hours. Anything that requires the mouse
becomes the thing they avoid doing.

- Every navigation action has a binding. Go to address, follow, back, forward,
  next xref, toggle pin.
- Back and forward are address history and must be reliable — they're the most
  used commands in the tool. See
  [`../architecture/ide-architecture.md`](../architecture/ide-architecture.md) §3.
- Quick access (`Ctrl+P`-style) is the primary way to reach anything by name.
- Renaming and commenting are inline, single-keystroke to start, `Esc` to
  abandon. If annotating is slower than thinking, analysts stop annotating and
  the interpretation layer stays empty.

## 5. Synchronization must be visible and defeatable

Views update each other constantly ([the focus
bus](../architecture/ide-architecture.md) §3). That's the product — and it's
infuriating when it fights you.

- Every synchronized view has a **pin** toggle in its title bar, visible without
  hovering. Comparing two functions is a core workflow and it requires freezing
  one side.
- When a view changes because something *else* was clicked, the change should be
  perceivable — a scroll, a highlight — rather than an instant silent swap that
  makes the analyst wonder what happened.
- Never move a view the analyst is actively typing into.

---

## Applying these

Per the repo's design guidance, describe a problem by its role and tier, not its
number: *"the listing's uncertainty treatment is competing with its xref
encoding"*, not *"make it 60% opacity"*. Name the feeling, find the principle
it breaks, then reach for the move.

When two principles conflict — density vs. visible uncertainty is the common
one — **uncertainty wins.** A dense view that misleads is worse than a slightly
looser one that doesn't.
