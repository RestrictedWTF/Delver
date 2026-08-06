# P0 Implementation Plan

> **Status: complete — code landed 2026-08-06. Archived.**
>
> Kept as written. Do not edit the plan body to match what was built; the gap
> between the two is the useful part. Corrections belong in an ADR or in the
> architecture docs.
>
> **Superseded by:** [p1-plan.md](../../planning/p1-plan.md)

## Outcome

All four stages landed: throwaway `delverHello` contrib (deleted in C3 as
planned), the Rust workspace and `delverctl`, build integration, the TS platform
layer, `IDelverTargetService`, and the `delverSections` view.

Two lint rules (`delver-address-is-bigint`, `delver-no-target-kind-branch`) and
a pre-commit hook landed with C4.

### Where execution diverged from the plan

| Planned | Built | Resolution |
| --- | --- | --- |
| Crates under `delver/crates/*` | Crates flat at `delver/*` | Spec adapted to flat — see [project-structure.md](../../architecture/project-structure.md) §2 |
| Crate `provider-file` → binary `delver-file` | Binary name matches crate name | Spec adapted; drops a redundant `[[bin]]` override |
| Binary crates unspecified internally | `lib.rs` + thin `main.rs` | Adopted as a rule — the logic is unit-testable without spawning a process |
| Branding was a P0 core item | Deferred | Split into [rebranding-plan.md](../../planning/rebranding-plan.md); nothing depended on it |

### Carried forward into P1

- Named-pipe and TCP transports in `delver-rpc` — stdio only shipped. P1 needs
  the named pipe for [E1](../../planning/p1-plan.md).
- `tsgo` (`npm run typecheck-client`) was crashing on this checkout, so the full
  typecheck and `npm run eslint` never ran green against the tree. Transpile
  succeeded. Upstream tooling issue, not a Delver type error — but it means the
  lint rules added in C4 are unverified against the full tree.

---

The walking skeleton: **IDE ↔ provider process ↔ a real PE file.**

Nothing here is user-facing beyond a throwaway view. The point is to prove every
boundary works before anything is built on top of one that doesn't.

Sizes are relative (S / M / L). See [roadmap.md](../../planning/roadmap.md) for how P0 fits.

---

## Ground state

Checked on 2026-08-06:

- **Rust is not installed.** `cargo` and `rustc` are absent. Install via
  `rustup` first — the repo already builds a Rust crate at `cli/`, so the
  toolchain is expected, just not present here.
- `node_modules/` is installed; `out/` contains only bootstrap files, so a full
  client compile hasn't been run yet.
- Node v24.19.0.
- No Delver code exists. `Docs/` and root `CLAUDE.md` are the only Delver
  artifacts.

## Shape of the plan

Three stages, ordered so each proves one boundary in isolation:

```
Stage A   Prove the fork builds and a contrib registers        (IDE end works)
Stage B   Rust workspace → provider → delverctl                (native end works, no IDE)
Stage C   Wire them together                                   (the boundary works)
```

**Stage B is developed and tested entirely from the command line.** That's the
whole reason `delverctl` exists this early — the analysis and provider side
never blocks on the VS Code build loop, and it stays true for the rest of the
project.

---

## Decisions — all accepted 2026-08-06

Six calls that were cheap to make now and expensive later. **All accepted.**

The two that outlive this document are recorded as ADRs, and their *content*
has been folded into
[`../architecture/target-providers.md`](../../architecture/target-providers.md) §3,
which is the standing spec:

- [ADR 0001](../adr/0001-wire-protocol-framing-and-encoding.md) — D1, D3, D4
- [ADR 0002](../adr/0002-wire-types-separate-from-domain-types.md) — D2

D5 and D6 are implementation choices recorded here and in the code; they don't
need ADRs. The summaries below stay for context while P0 is in progress.

### D1 — Addresses on the wire are hex strings, not JSON numbers

**This is the one that will silently corrupt data if you get it wrong.** JSON
numbers are IEEE 754 doubles. A `u64` address above 2^53 loses precision the
moment `JSON.parse` touches it, and nothing errors — `0x7FFFFFFFFFFFFFFF` just
quietly becomes a different address.

Serde will happily serialize `u64` as a JSON number. Don't let it.

**Decision:** every address, length, and offset crosses the wire as a
`"0x..."` string. Serialize with a `#[serde(with = "hex_u64")]` helper in
`delver-protocol`; parse to `bigint` on the TS side. Ugly, explicit, debuggable
in a log, and impossible to get subtly wrong.

### D2 — Wire types and domain types are separate

`delver-protocol` holds wire types: stable, versioned, serde-annotated, hex
strings. `delver-core` holds domain types: `u64`, ergonomic, free to refactor.
`From`/`TryFrom` impls between them.

Tempting to skip and use one set. Don't — the first internal refactor becomes a
breaking protocol change, and you'll be shipping provider binaries that outlive
IDE builds.

### D3 — Framing

LSP-style headers for JSON, with a distinct frame type for binary payloads:

```
Content-Length: <n>\r\n
\r\n
<n bytes of UTF-8 JSON>
```

```
Delver-Frame: <id>\r\n
Content-Length: <n>\r\n
\r\n
<n bytes raw>
```

A response references a frame inline: `{"data": {"$frame": 17, "len": 4096}}`.

**Ordering rule:** binary frames always immediately follow the JSON message that
references them, before the next JSON message. That keeps the reader a simple
state machine instead of a correlation table.

### D4 — Error model

JSON-RPC error object. Standard codes for protocol-level failures; a Delver
range for domain failures, with `data: { kind, detail }`.

Initial kinds: `ProtocolVersionMismatch`, `NotAttached`, `InvalidAddress`,
`UnreadableMemory`, `UnsupportedCapability`, `TargetBusy`.

`UnreadableMemory` is an error only when *nothing* was readable — a partial read
is a **success** carrying valid-range information. That's invariant #7 in
`CLAUDE.md` and the protocol has to make the right thing the easy thing.

### D5 — Crates, and no async yet

Match `cli/`: edition 2021, same MSRV.

| Need | Crate |
| --- | --- |
| Serialization | `serde`, `serde_json` |
| Schema generation | `schemars` |
| Binary formats | `object` — uniform API across PE/ELF/Mach-O, which pays off later |
| File mapping | `memmap2` |
| Errors | `thiserror` (libs), `anyhow` (binaries) |
| CLI | `clap` (already used by `cli/`) |

**No `tokio`.** The file provider is pure request/response; std threads and
blocking I/O are simpler and easier to debug. Add async only when a provider
actually needs it — and the Windows debugger won't, since it needs a dedicated
OS thread anyway.

### D6 — The file provider exposes two address spaces

`File` (raw offsets) and `Image` (RVA, sections applied), with
`translatesTo` linking them.

This is deliberate. It exercises the multi-space model on day one with the
simplest possible backend, and it's the same machinery the memory-vs-disk diff
needs in P4. A single-space file provider would make the model look like
over-engineering right up until it breaks.

---

## The v0 protocol surface

Five methods. Resist adding more.

| Method | Returns |
| --- | --- |
| `initialize` | `protocolVersion`, capabilities, address spaces, target descriptor |
| `listSpaces` | address spaces with kinds, pointer width, `translatesTo` |
| `getImageInfo` | arch, entry point, sections, image base |
| `readMemory(space, addr, len, moment)` | binary frame + valid ranges + served moment |
| `shutdown` | — |

Imports, exports, and symbols are **P1**, not P0. Sections are enough to prove
the pipe.

---

## Tasks

### Stage A — prove the IDE end

**A1 · Install Rust and build the fork** — S
`rustup` install, then `npm run compile` (or `watch`). Launch via the `launch`
skill.
*Done when:* Code OSS starts from sources.

**A2 · Throwaway hello contrib** — S
`src/vs/workbench/contrib/delverHello/browser/delverHello.contribution.ts`
registering a `delver.hello` command. One import line in
`src/vs/workbench/workbench.common.main.ts`.
Add the first row to [`../development/patch-surface.md`](../../development/patch-surface.md).
*Done when:* `Delver: Hello` runs from the command palette. **Deleted in C3.**

### Stage B — prove the native end

**B1 · Workspace + `delver-core`** — M
`delver/Cargo.toml` (workspace), `rustfmt.toml` copied from `cli/`.
`delver-core`: `Location`, `AddressSpace`, `SpaceId`, `Moment`, `MomentKind`,
`Anchor`, `TargetCapability`. Domain types, `u64`, no serde.
*Done when:* `cargo build` and `cargo clippy -D warnings` are clean.

**B2 · `delver-protocol` + codegen** — M
Wire types with serde + schemars, hex-string addresses (D1), `From` impls to
`delver-core` (D2). A `gen-schema` bin emitting
`delver/schema/protocol.schema.json`.
npm script `delver:protocol` producing
`src/vs/platform/delver/common/protocol.generated.ts` with a
`// GENERATED — DO NOT EDIT` header.
*Done when:* regenerating twice produces no diff, and a round-trip test proves
`0x7FFFFFFFFFFFFFFF` survives serialize → JSON → deserialize.

**B3 · `delver-rpc`** — M
Framed reader/writer per D3, client and server halves, error model per D4.
*Done when:* unit tests cover a JSON message, a message with a trailing binary
frame, a split read across buffer boundaries, and a malformed header.

**B4 · `provider-file`** — M
mmap the file, parse PE with `object`, expose `File` and `Image` spaces (D6),
implement the five methods.
*Done when:* it serves `initialize` and `readMemory` over stdio, and a read
spanning past the end of a section returns partial-valid data rather than an
error.

**B5 · `delverctl`** — S
`delverctl info <file>`, `spaces <file>`, `read <file> <addr> <len>`.
*Done when:* `delverctl info notepad.exe` prints arch, entry, and sections; and
`delverctl read notepad.exe 0x140001000 64` prints a hex dump. **This is the
acceptance test for Stage B.**

### Stage C — wire them together

**C1 · Build integration** — M
`build/gulpfile.delver.ts` modelled on `build/gulpfile.cli.ts`. Stage binaries
to `resources/delver/bin/<platform>/`. npm scripts: `delver:build`,
`delver:test`, `delver:protocol`.
*Done when:* `npm run delver:build` produces staged binaries.

**C2 · TS platform layer** — M
`src/vs/platform/delver/common/`: `address.ts`, `moment.ts`, `anchor.ts`,
`target.ts`, `capabilities.ts`, `rpc.ts` + the generated protocol file.
`node/providerProcess.ts` (spawn, supervise, restart), `node/delverBinaries.ts`
(staged path in a packaged build, `delver/target/debug/` in dev).
*Done when:* a node-layer test spawns `provider-file` and gets `initialize`
back.

**C3 · Service + throwaway view** — M
`IDelverTargetService` with `attach(kind, config)` / `activeTarget`.
Command `delver.target.openFile`. Replace `delverHello` with `delverSections`,
a tree view listing sections of the attached file.
*Done when:* open a PE from the palette, see its sections in the sidebar.
**This is the P0 exit criterion.**

**C4 · Close out** — S
Update [`status.md`](../../planning/status.md) and [`ledger.md`](../../planning/ledger.md). Add the first
lint rules (`delver-address-is-bigint`, `delver-no-target-kind-branch`) and the
format-on-write hooks. Write ADRs for D1 and D3 if they were contentious.

---

## Definition of done

- `delverctl info <pe>` and the sections view show the **same data from the same
  provider binary**.
- Killing the provider process mid-session logs an error and doesn't take the
  workbench with it.
- `npm run delver:protocol` is a no-op on a clean tree.
- Every address in the codebase is `bigint` or `u64`. No `number`.
- [`../development/patch-surface.md`](../../development/patch-surface.md) lists
  exactly the upstream files touched — expected: `product.json`,
  `workbench.common.main.ts`, `build/gulpfile.ts`, `package.json`.

## Explicitly not in P0

Disassembly · SQLite persistence · the interpretation layer · sandboxing ·
editor inputs (a tree view is enough) · capability-gating UI · imports/exports/
symbols · the focus bus · ELF and Mach-O.

---

## First three tasks of P1

So the transition is obvious rather than a fresh planning session:

1. **Extend the loader** — imports, exports, relocations, exception directory.
   Same provider, more of `getImageInfo`.
2. **`server-analysis` process + `delver-disasm`** — windowed decode via
   `iced-x86`, and a `disassemble(range, moment)` protocol method. Verify
   through `delverctl` before touching the IDE, exactly as in Stage B.
3. **Listing editor** — `DelverListingInput` + `EditorPane` + `WorkbenchTable`,
   modelled on `src/vs/workbench/contrib/debug/browser/disassemblyView.ts`.
   Read that file before starting.

Full detail in [roadmap.md](../../planning/roadmap.md) P1.
