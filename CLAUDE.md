# Delver

An AI-native reverse engineering and malware analysis workspace, built on a fork
of VS Code. Design lives in [`Docs/`](Docs/README.md) — read
[`Docs/README.md`](Docs/README.md) before designing anything new.

Upstream VS Code conventions still apply; see `.claude/CLAUDE.md`.

## Invariants

Do not violate these without writing an ADR (`Docs/history/adr/`). A fresh session gets
these wrong by default — that's why they're here.

**Data model** ([`Docs/architecture/data-model.md`](Docs/architecture/data-model.md))

1. Every read of target data takes an `ILocation` **and** an `IMoment`. No
   exceptions, including the file provider where the Moment is constant.
2. Addresses are `bigint` in TypeScript and `u64` in Rust. Never `number`.
   **On the wire they are `"0x..."` strings, never JSON numbers** — JSON numbers
   truncate above 2⁵³ without erroring
   ([ADR 0001](Docs/history/adr/0001-wire-protocol-framing-and-encoding.md)).
3. Facts (bytes, instructions, xrefs — recomputable) and interpretation (names,
   comments, types — authored) are separate stores. Never mix them.
4. Annotations anchor to `(contentHash, rva)`. Never to absolute addresses.
5. Interpretation is append-only and always has an author. No silent mutation.

**Targets** ([`Docs/architecture/target-providers.md`](Docs/architecture/target-providers.md))

6. No code branches on `target.kind`. Use `TargetCapability`. If you need the
   kind to decide behavior, the missing thing is a capability.
7. `readMemory` returns valid-range information. Never zero-fill unreadable
   memory.

**Structure** ([`Docs/architecture/project-structure.md`](Docs/architecture/project-structure.md))

8. The renderer never parses target bytes. Parsing happens in a provider or the
   analysis server, out of process.
9. No contrib imports another contrib's internals. Shared code moves to
   `src/vs/workbench/services/delver/` or `src/vs/platform/delver/`.
10. Do **not** touch `src/vs/workbench/api/**`. Scripting is Python over DTP —
    see [`Docs/architecture/ide-architecture.md`](Docs/architecture/ide-architecture.md) §5.
11. Touching any upstream file means adding a row to
    [`Docs/development/patch-surface.md`](Docs/development/patch-surface.md) in the same change.
12. `protocol.generated.ts` and `protocol.schema.json` are generated. Edit the
    `delver-protocol` crate and regenerate.
13. Native code is Rust, in `delver/`. Anything touching attacker-controlled
    bytes is Rust and `#![forbid(unsafe_code)]` where possible.

**Working agreement** ([`Docs/development/working-with-ai.md`](Docs/development/working-with-ai.md))

14. **If a decision isn't recorded in `Docs/`, raise it — don't invent it.**
    Silent architectural drift is the main risk on this project.
15. Don't run builds, typechecks, or test suites to verify your own work unless
    asked. The human does that.
16. At the end of a working session, update [`Docs/planning/status.md`](Docs/planning/status.md).
    Add or update a [`Docs/planning/ledger.md`](Docs/planning/ledger.md) row when a feature's
    status changes.
17. When a session's conclusion changes the design, update the relevant doc in
    the same session. A stale design doc is worse than none.

## Naming

`delver.<area>.<verb>` commands · `delver.<noun>` context keys ·
`delver.view.<name>` views · `delver.editor.<name>` editors · `delver-<kind>:`
URI schemes · `delver-<role>` crates · `delver<Area>` contrib folders.

Never introduce a bare `Address`, `Target`, or `Session` type in a shared scope —
they collide with upstream concepts.
