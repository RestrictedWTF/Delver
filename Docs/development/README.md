# Development

**How to work on this repo.** Working agreements, fork discipline, and the setup
that keeps the codebase clean. Changes rarely.

| Doc | Covers |
| --- | --- |
| [working-with-ai.md](working-with-ai.md) | Invariants, the three records, lint enforcement, skills, what not to automate, sizing work |
| [patch-surface.md](patch-surface.md) | Every upstream file Delver modifies, and the merge checklist |
| [external-agents.md](external-agents.md) | Wiring an MCP client to a Delver window: the generic `.mcp.json`, client recipes, approval, troubleshooting |

## To add here as the project grows

- `build.md` — building the fork plus the Rust workspace, and the inner loop
- `testing.md` — unit tests, the golden corpus, the AI eval harness
- `upstream-merges.md` — the monthly merge procedure, once it's been done twice
  and the sharp edges are known

Don't write these speculatively. Write each one the second time you have to
explain it.

## The short version

- New files over edits to upstream files, always. A touched upstream file means
  a row in [patch-surface.md](patch-surface.md) in the same change.
- Enforcement over convention — a lint rule beats a documented rule, because the
  feedback is immediate and doesn't need you in the loop.
- Automate cheap cleanliness (format on write), not expensive verification
  (builds, typechecks, test suites). The human verifies.
- If a decision isn't recorded in `Docs/`, raise it — don't invent it.
