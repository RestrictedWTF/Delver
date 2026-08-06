# Design

**What Delver looks like and how it behaves.** Separate from
[`../architecture/`](../architecture/), which covers how it's built.

| Doc | Covers |
| --- | --- |
| [principles.md](principles.md) | Delver-specific design principles — the ones that don't come free from VS Code |

## Inherited design system

Delver is a VS Code fork, so it inherits VS Code's design language, tokens, and
component vocabulary. Do not invent a parallel one — a view that doesn't look
like the rest of the workbench reads as broken, not as branded.

The upstream guidance already in this repo applies:

- `.github/instructions/design-philosophy.instructions.md` and
  `.github/skills/design-philosophy/` — the Values → Principles → Moves
  vocabulary. Reason in design terms (name the feeling, find the principle it
  breaks, reach for the move), not in pixels.
- `.github/instructions/design-tokens.instructions.md` — the token reference.

[principles.md](principles.md) covers only what's *additional* because Delver is
a reverse engineering tool.

## Surfaces to spec

One doc per surface, written when that surface is designed — not before.
Suggested order matches [`../planning/roadmap.md`](../planning/roadmap.md):

| Surface | Phase | Status |
| --- | --- | --- |
| Listing (disassembly) | P1 | not started |
| Strings, imports, exports | P1 | not started |
| Pseudocode + listing pairing | P2 | not started |
| Findings and evidence chain | P3 | not started |
| AI proposal review | P3 | not started |
| Hex and memory map | P4 | not started |
| Runtime views | P4 | not started |
| Diff (memory vs. disk) | P4 | not started |
| Region lifecycle timeline | P4 | not started |
| CFG and call graph | P5 | not started |

A surface spec should cover: what the analyst is trying to learn, the
information hierarchy, what's shown at rest vs. on demand, keyboard-first
behavior, and how the surface indicates uncertainty. It does not need mockups if
words are clearer.
