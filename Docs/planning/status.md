# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [LEDGER.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-06
**Current phase:** P1 Stage D1 — named-pipe transport and provider `--listen`

## In flight

D1 · Named-pipe transport in `delver-rpc` and `--listen <endpoint>` mode in
`provider-file`.

- Add a cross-platform listener (Windows named pipe + Unix socket) to
  `delver-rpc`.
- Refactor `provider-file` to accept either stdio or listener mode and serve
  read-only clients concurrently.
- Update `delverctl` to connect to a listening provider.
- Done when two `delverctl` instances read from one provider concurrently.

## Rust status

Installed: `cargo 1.97.1`, `rustc 1.97.1`, default toolchain
`stable-x86_64-pc-windows-msvc`. The binaries live in `$HOME/.cargo/bin` and
are **not yet on `PATH`** by default.

To use Rust in a fresh shell:
```bash
source "$HOME/.cargo/env"
```

Or add `$HOME/.cargo/bin` to your system/user `PATH` so it persists.

## Decisions

P0 decisions remain accepted. P1 decision E1 (named-pipe transport, provider
accepts multiple clients) is the driver for the current work.

- [ADR 0001](../history/adr/0001-wire-protocol-framing-and-encoding.md) — wire framing, hex-string numbers, error model
- [ADR 0002](../history/adr/0002-wire-types-separate-from-domain-types.md) — wire types separate from domain types

D5 (crate picks, no async runtime) and D6 (file provider exposes `File` and
`Image` spaces) are recorded in [p0-plan.md](../history/plans/p0-plan.md) only.

## Known broken / stubbed

- `tsgo` (the TypeScript Go compiler used by `npm run typecheck-client`) is
  crashing on this checkout with an out-of-memory/internal error. Transpile
  (`npm run transpile-client`) succeeds. This appears to be an upstream tooling
  issue rather than a Delver type error, but it blocks the full typecheck.
- Lint rules are in place but have not been run against the full tree because
  `npm run eslint` also exercises the typecheck path.

## Open questions

- Whether VS Code has a clean contribution point for injecting env vars into
  both the integrated terminal and notebook kernel processes. If it does, the
  `DELVER_SESSION` row in [PATCH-SURFACE.md](../development/patch-surface.md) disappears and
  scripting costs zero upstream edits.
- Ghidra decompiler version to pin, and how much of its source to vendor
  ([07-Roadmap.md](roadmap.md) P2b).

## Recently decided

- Priority is static RE + decompilation + AI before runtime (P1 → P2 → P3 → P4)
- Scripting is Python over DTP; no TypeScript extension API
- Minidump is the second provider, carrying abstraction validation while the
  debugger is deferred to P4
