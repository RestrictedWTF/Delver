# Project Structure

The directory layout, naming conventions, and boundary rules. Written for a
codebase that will be large and long-lived inside a fast-moving fork.

Two forces shape everything here:

1. **Merge cost.** A new top-level directory never conflicts with upstream. An
   edit to a shared upstream file conflicts constantly. Push work into new
   directories relentlessly.
2. **Findability.** In two years, someone should be able to guess where a thing
   lives from its name alone, without grepping.

---

## 1. Top level

```
Delver/
├── Docs/                  # these documents
├── build/                 # UPSTREAM  (+ one new file: gulpfile.delver.ts)
├── cli/                   # UPSTREAM Rust crate — do not touch
├── delver/                # ALL Delver native code. One Rust workspace.
├── extensions/            # UPSTREAM  (+ extensions/delver-* )
├── remote/                # UPSTREAM
├── resources/             # UPSTREAM  (+ resources/delver/ icons, binaries)
├── scripts/               # UPSTREAM
├── src/                   # UPSTREAM  (+ src/vs/**/delver* )
└── test/                  # UPSTREAM
```

Only two new top-level entries: `Docs/` and `delver/`. Everything else is an
additive subdirectory inside an existing tree.

**Precedent for `delver/`:** the repo already builds a Rust crate at `cli/`
(`cli/Cargo.toml`, `cli/build.rs`, wired up by `build/gulpfile.cli.ts`). The
toolchain, CI, and packaging patterns exist — follow them rather than inventing
a parallel system.

---

## 2. `delver/` — native code

One Cargo workspace, **crates flat at the workspace root**. Libraries are
crates; every process Delver spawns is a binary crate.

```
delver/
├── Cargo.toml                    # [workspace] — explicit members list
├── Cargo.lock                    # committed; these are shipped binaries
├── rustfmt.toml                  # copied from cli/rustfmt.toml
│
├── schema/                       # generated protocol schema (checked in)
│   └── protocol.schema.json
│
├── corpus/                       # golden test binaries + expected facts   (P1)
│   ├── samples/                  # git-lfs; benign binaries only in-repo
│   └── expected/                 # *.json snapshots
│
├── clients/
│   └── python/                   # the `delver` pip package — DTP client   (P3)
│
├── delver-core/                  # Location, Moment, Anchor, capabilities, IDs
├── delver-protocol/              # wire types. SINGLE SOURCE OF TRUTH.
├── delver-rpc/                   # JSON-RPC + length-prefixed binary frames
├── delver-store/                 # SQLite: fact cache + append-only edit log
├── delver-format/                # PE / ELF / Mach-O / minidump parsing
├── delver-disasm/                # iced-x86 wrapper, windowed decode
├── delver-analysis/              # function detection, xrefs, strings, CFG
├── delver-decompile/             # decompiler responder + backends         (P2)
│
├── provider-file/                # [bin] provider-file
├── provider-dump/                # [bin] provider-dump                     (P2)
├── provider-winproc/             # [bin] provider-winproc                  (P4)
├── provider-emu/                 # [bin] provider-emu                      (P6)
│
├── server-analysis/              # [bin] server-analysis
└── delverctl/                    # [bin] delverctl — headless harness
```

Phase markers show when a crate arrives. Unmarked crates are P0–P1; see
[`../planning/ledger.md`](../planning/ledger.md) for what actually exists today.

### Why flat, and what it costs

The crates sit at the workspace root rather than under `crates/`. At this scale
the root stays readable, and there are only three non-crate directories
(`schema/`, `corpus/`, `clients/`) plus the ignored `target/`.

Two consequences to live with:

- **`members` is an explicit list**, not a `crates/*` glob. Adding a crate means
  adding a line. Fine — it's a deliberate act, and the list doubles as an index.
- **The name prefix is the grouping.** With no directory to separate them,
  `delver-*` / `provider-*` / `server-*` is what keeps the root sorted into
  meaningful blocks. The prefix convention in §7 is therefore load-bearing
  here, not cosmetic.

Revisit if the crate count passes ~20.

### Binary names match crate names

`provider-file` builds `provider-file`; `server-analysis` builds
`server-analysis`. No `[[bin]] name` override, so Cargo's default applies and
there's one less thing to keep in sync. `delverctl` is the only binary a user
ever invokes directly.

### Versions live in the workspace

Every crate inherits from `[workspace.package]` and takes dependencies from
`[workspace.dependencies]`:

```toml
[package]
name = "delver-core"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { workspace = true }
delver-protocol = { workspace = true }
```

One place to bump a version, and no chance of two crates disagreeing about which
`serde` they want. Internal path dependencies are declared once in
`[workspace.dependencies]` too.

### Crate rules

- **Providers never link the analysis crates, and vice versa.** A provider
  serves bytes and target state; the analysis server interprets them. Keeping
  them unlinked is what keeps the sandbox boundaries meaningful and what lets a
  provider run on a different machine.
- Only `delver-core` and `delver-protocol` may be depended on by everything.
- **Binary crates are `lib.rs` + a thin `main.rs`.** The logic lives in the lib
  so it can be unit-tested without spawning a process; `main.rs` does argument
  parsing and wires stdio to the server loop. `provider-file` is the reference.
- **Nothing depends on another binary crate's lib.** The lib exists for that
  crate's own tests, not as a shared surface — `delverctl` talks to
  `provider-file` over DTP like any other client, never by linking it. Shared
  code moves down into `delver-core` or a new library crate.
- Anything touching hostile bytes is `#![forbid(unsafe_code)]` unless it
  physically cannot be — and where it can't (`provider-winproc` needs Win32),
  the `unsafe` is confined to one clearly-named module with a comment per block.

### Why providers are separate binaries, not one binary with subcommands

Different sandbox profiles, different crash blast radii, different deployment
(a provider may run on another machine), and different platform availability.
The cost is a few Cargo.toml files.

---

## 3. The protocol — one source of truth

Hand-maintaining Rust and TypeScript copies of the wire types is the single most
reliable way to introduce silent drift in a project like this.

```
delver-protocol (Rust, serde + schemars)
        │  cargo run -p delver-protocol --bin gen-schema
        ▼
delver/schema/protocol.schema.json      (checked in)
        │  npm run delver:protocol
        ▼
src/vs/platform/delver/common/protocol.generated.ts   (checked in, DO NOT EDIT)
```

Rust is authoritative; TypeScript is generated. Both artifacts are checked in so
a TypeScript-only build never needs a Rust toolchain. CI asserts that
regenerating produces no diff.

Version the protocol from the first commit (`protocolVersion` in the handshake)
and have the host refuse to attach to a mismatched provider with a clear message.
You will ship a provider binary that outlives an IDE build; plan for it.

---

## 4. TypeScript layout

Follows the existing layering (`base` → `platform` → `editor` → `workbench`),
enforced by `.eslint-plugin-local/code-layering.ts` and `code-import-patterns.ts`.

```
src/vs/platform/delver/
├── common/
│   ├── address.ts              # SpaceId, IAddressSpace, ILocation, IAddressRange
│   ├── moment.ts               # IMoment, MomentKind
│   ├── anchor.ts               # Anchor kinds + resolution results
│   ├── target.ts               # ITargetProvider, ITargetDescriptor
│   ├── capabilities.ts         # TargetCapability
│   ├── interpretation.ts       # IEdit, IAuthor, EditOp
│   ├── findings.ts             # IFinding, EvidenceRef
│   ├── recipe.ts               # IRecipe  (schema only until P6)
│   ├── protocol.generated.ts   # GENERATED — do not edit
│   └── rpc.ts                  # client-side transport
├── node/
│   ├── providerProcess.ts      # spawn / supervise / restart
│   └── delverBinaries.ts       # resolve shipped vs. dev-build binaries
└── test/common/…

src/vs/workbench/services/delver/
├── common/
│   ├── targetService.ts        # IDelverTargetService
│   ├── focusService.ts         # IDelverFocusService (the sync bus)
│   ├── analysisService.ts      # IDelverAnalysisService
│   ├── interpretationService.ts
│   └── projectService.ts       # .delver open/save
├── electron-browser/           # implementations that need Node
└── test/…

src/vs/workbench/contrib/
├── delverListing/              # disassembly editor
├── delverMemory/               # hex, memory map, region lifecycle
├── delverStrings/
├── delverRuntime/              # processes, threads, modules, handles
├── delverDebug/                # breakpoints, stepping, call stack
├── delverFindings/
├── delverGraph/                # CFG, call graph            (P5+)
├── delverPseudocode/           #                            (P2)
└── delverAI/                   #                            (P3)
```

Each contrib:

```
contrib/delverListing/
├── browser/
│   ├── delverListing.contribution.ts   # the only file registered from workbench.common.main.ts
│   ├── listingEditor.ts                # EditorPane
│   ├── listingInput.ts                 # EditorInput
│   ├── listingDataSource.ts
│   └── media/listing.css
├── common/                              # types shared within this contrib
└── test/browser/…
```

### Boundary rules — the ones that keep a big project clean

1. **No contrib imports another contrib's internals.** If two contribs need the
   same thing, it moves to `services/delver/` or `platform/delver/`. The
   `code-no-deep-import-of-internal` lint rule already exists to enforce this.
2. **`platform/delver/` has no workbench dependencies** and no UI. It's the
   vocabulary layer: types, protocol, process management.
3. **One contrib per user-visible surface.** When a contrib grows a second
   unrelated surface, split it.
4. **Services declare dependencies in constructors only** — per the repo
   guidelines, never via `IInstantiationService` later.
5. Tests live in `test/{common,browser,node}/` beside the code, per VS Code
   convention.

---

## 5. Extensions

```
extensions/delver-samples/       # example Python scripts + investigation notebooks
extensions/delver-yara/          # optional integrations (P6)
extensions/delver-ghidra-bridge/ # MCP or extension-based decompiler bridge
```

Prefer shipping optional capability as an extension rather than a contrib.
Anything that can live behind the `delver.*` API should, because it isolates it
from the fork's merge surface entirely.

---

## 6. Build integration

- `build/gulpfile.delver.ts` — new file, modelled directly on
  `build/gulpfile.cli.ts`. Builds the Cargo workspace and stages binaries.
- Staged output: `resources/delver/bin/<platform>/`. `delverBinaries.ts` resolves
  from there in a packaged build and falls back to `delver/target/debug/` in
  development, so `cargo build` is enough for the inner loop.
- `package.json` scripts:

```
"delver:build"       cargo build --manifest-path delver/Cargo.toml
"delver:test"        cargo test  --manifest-path delver/Cargo.toml
"delver:protocol"    regenerate schema + protocol.generated.ts
"delver:corpus"      run the golden-corpus regression suite via delverctl
```

- CI gates: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
  protocol-regeneration no-diff, `npm run typecheck-client`,
  `npm run valid-layers-check`, unit tests, golden corpus.

---

## 7. Naming conventions

Consistency here is worth more than it looks once there are hundreds of
identifiers.

| Kind | Pattern | Example |
| --- | --- | --- |
| Command ID | `delver.<area>.<verb>` | `delver.listing.goToAddress` |
| Context key | `delver.<noun>` | `delver.target.hasThreads` |
| Setting | `delver.<area>.<setting>` | `delver.listing.showBytes` |
| Storage key | `delver.<area>.<key>` | `delver.project.recent` |
| View ID | `delver.view.<name>` | `delver.view.threads` |
| Editor type ID | `delver.editor.<name>` | `delver.editor.listing` |
| URI scheme | `delver-<kind>` | `delver-pseudo:` |
| Rust crate | `delver-<role>` · `provider-<x>` · `server-<x>` | `delver-disasm` |
| Shipped binary | same as the crate — no `[[bin]]` override | `provider-winproc` |
| Contrib folder | `delver<Area>` | `delverListing` |

Never introduce a bare `Address`, `Target`, or `Session` type in a shared scope —
those names collide with upstream concepts and make grepping useless. Prefix or
qualify.

---

## 8. Ownership and process

- `CODEOWNERS` per area once there's more than one person: `delver/*`,
  `src/vs/platform/delver/`, each contrib.
- PR checklist: touched an upstream file → updated
  [PATCH-SURFACE.md](../development/patch-surface.md)? Changed the protocol → regenerated and
  bumped the version? Added a parser path → added a corpus case?
- ADRs for decisions that are expensive to reverse (disassembler engine,
  decompiler backend, storage format). Short — one page, `Docs/adr/NNN-title.md`.
  These docs are the current standing decisions; ADRs record changes to them.

---

## 9. What this buys you

- Upstream merges touch `product.json`, one block in `workbench.common.main.ts`,
  and `build/`. Nothing else — scripting deliberately avoids the `extHost.*`
  files ([04-IDE-Architecture.md](ide-architecture.md) §5), which removes the
  fork's three highest-conflict touch points.
- The analysis engine is developable and testable with no IDE running.
- Providers can be moved to another machine without an architectural change.
- Any Delver file is identifiable from its path alone.
