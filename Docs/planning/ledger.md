# Feature Ledger

One row per feature. This is what makes it possible to **skip, fall back, or
revisit** anything at any point without re-deriving the context.

The **"Deliberately not done"** column is the load-bearing one. Six months on,
the question is never "does this work" — it's *"did we skip that on purpose, and
what did we know at the time?"*

## Status values

| Status | Meaning |
| --- | --- |
| `planned` | In the roadmap, not started |
| `wip` | Being built; see [STATUS.md](status.md) for where |
| `stub` | Interface exists, implementation is a placeholder |
| `done` | Built and used |
| `skipped` | Deliberately not built. **Reason required.** |
| `superseded` | Replaced. Link the ADR. |
| `removed` | Was built, then dropped. **Reason required.** |

## Falling back

Every feature is a contrib, so removing one is deleting a single import line
from `workbench.common.main.ts`. Set the row to `removed`, say why, and keep the
"deliberately not done" notes — that's the context a future revisit needs.

For ship-but-disabled, use a `delver.experimental.*` configuration flag rather
than a branch.

---

## P0 — Skeleton

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| Cargo workspace | `done` | `delver/` | | |
| `delver-core` domain types | `done` | `delver/delver-core` | | |
| `delver-protocol` + TS codegen | `done` | `delver/delver-protocol` | | |
| `delver-rpc` transport | `done` | `delver/delver-rpc` | TCP transport not implemented; named pipe landed in P1 D1 | [ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md) |
| `provider-file` (PE headers) | `done` | `delver/provider-file` | ELF, Mach-O | |
| Provider process host | `done` | `src/vs/platform/delver/node/` | Sandboxing (deferred to P4) | |
| `delverctl` | `done` | `delver/delverctl` | | |
| Delver sections view | `done` | `src/vs/workbench/contrib/delverSections/` | | |
| Delver view container | `done` | `services/delver/browser/delverViewContainer.ts` | Custom container icon artwork — see [rebranding-plan.md](rebranding-plan.md) | |
| Delver target service | `done`, **unwired** | `src/vs/workbench/services/delver/` | Registered and tested but no UI consumer since sections moved onto the analysis session (2026-08-07). Retained because it models an attached target with capabilities and spaces, which P4 live-process attach needs and the file-only session does not cover. **Decide before Stage F.** Earlier fix: the snapshot carried `bigint` across IPC and hung `attach()` silently | [0001](../history/adr/0001-wire-protocol-framing-and-encoding.md) |
| Build integration | `done` | `build/gulpfile.delver.ts`, `package.json` | | |
| Protocol codegen (Rust → schema → TS) | `done` | `delver-protocol/src/bin/gen-schema.rs`, `build/lib/delver/generate-protocol.ts` | Repaired 2026-08-07: the TS emitter was a hardcoded string and the schema only carried the envelope, so no payload type had ever been generated | |
| Branding + CI | `planned` | `product.json`, `build/`, `resources/` | Icons, installer artwork, Linux packaging — see [rebranding-plan.md](rebranding-plan.md) | |
| Theme (`theme-delver`) | `planned` | `extensions/theme-delver` | Product icon + file icon themes deferred | |

## P1 — Static core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| Named-pipe / Unix-socket transport | `done` | `delver/delver-rpc` | TCP transport; see also P0 `delver-rpc` row | [0003](../history/adr/0003-unsafe-code-in-transport-listener.md) |
| Imports / exports / seeds over DTP | `done` | `delver/provider-file`, `delver/delver-protocol` | Exports and seeds are not surfaced in the UI yet — see [stage-g-plan.md](stage-g-plan.md) | |
| Imports view | `done` | `contrib/delverImports` | Filtering, delay-load imports shown as ordinary ones, no grouping by suspiciousness | |
| Functions view | `done` | `contrib/delverFunctions` | Filter box and full virtualization — swept entries are capped at 1,000 with an explicit overflow row. Names need Stage F | |
| Overview view | `done` | `contrib/delverOverview` | Hashes, compile timestamp, entropy, packer hints | |
| PE loader (`delver-format`) | `done` | `delver/delver-format` | Resource-directory *contents* (the directory itself is parsed); ELF and Mach-O (P5) | |
| Analysis server | `done` | `delver/server-analysis` | Progress notifications during indexing (no longer urgent: 88.5 MB image analyses in ~3.9 s after the 2026-08-07 indexing work); multi-image sessions (one image at a time) | |
| Disassembly (`delver-disasm`) | `done` | `delver/delver-disasm` | Non-x86 architectures; instruction index is D5 | |
| Function detection | `done` | `delver/delver-analysis` | Signature matching (P5); sweep heuristics are deliberately naive — see status | |
| Analysis session host | `done` | `platform/delver/node/analysisSession.ts` | Progress reporting during indexing; one image per session | |
| Listing editor | `done` | `contrib/delverListing` | Inline source interleaving (needs dynamic row heights); **full-file scrollbar** — the buffer slides, see status; xref columns, context menu, and byte column | |
| Analysis service (renderer ↔ shared process) | `done` | `platform/delver/{common,node,electron-browser}/delverAnalysisService.ts` | Session reuse between sections view and listing — each opens its own provider today | [0001](../history/adr/0001-wire-protocol-framing-and-encoding.md) |
| Xrefs | `done` | `delver/delver-analysis` | Graph query API (P6); indirect-call targets need dataflow | |
| References view | `done` | `contrib/delverXrefs` | Grouping by function (needs Stage F names); filtering by kind | |
| Follow / return traversal | `done` | `contrib/delverListing` | Following a data reference into a hex view (needs the hex view); operand-level links for non-branch operands | |
| Strings view | `done` | `contrib/delverStrings` | Filter box; encoding as a column rather than a suffix. Scan cap stays at 200k but now reports truncation | |
| Exports view | `done` | `contrib/delverExports` | Filtering; forwarded exports are shown but not navigable | |
| Navigation (address/function/history) | `done` | `contrib/delverListing/browser/delverListingNavigation.ts` | Go to String — quick-pick scale plus the 200k string cap; belongs with the strings view. Named symbols need the interpretation layer | |
| Session registry | `done` | `services/delver/common/delverSessionService.ts` | Multiple concurrent sessions — one active session at a time | |
| Focus bus | `done` | `services/delver/common/delverFocusService.ts` | Thread/frame focus (P4) | |
| Per-view pin | `done` | `contrib/delverListing/browser/delverListingContext.ts` | Not persisted across reloads; only the listing has one so far. Pin is per-view state, never bus state, and keys on focus *reason* — see status | |
| Interpretation layer | `wip` | `platform/delver/common/interpretation.ts`, `services/delver/common/delverInterpretationService.ts` | **Persistence — names die with the window; the `.delverdb` store is next.** Comments have an op but no UI; listing rows do not show names; rename only from the listing. Types (P5); merge and conflict detection (P6) | |
| Content hash (image identity) | `done` | `delver/provider-file` | Normalized hashing for in-memory images, which P4 needs so a loaded module matches its on-disk counterpart | |
| `.delverdb` project | `planned` | `delver/delver-store` | | |
| Golden corpus | `done` | `delver/corpus` | Real-binary samples: F4 forbids non-redistributable ones, so samples are synthesised. Local-only real binaries by path are not wired up yet | |
| Hex view | `planned` | `contrib/delverMemory` | **Slidable to P4** — nothing in P2/P3 needs it | |

## P2 — Decompilation & p-code

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| `IDecompilerService` | `planned` | `services/delver/common/` | | |
| Ghidra headless scaffold | `planned` | — | **Scaffold only. Delete in P2b — the JVM must never ship.** | |
| Pseudocode editor | `planned` | `contrib/delverPseudocode` | | |
| Line ↔ address map | `planned` | `contrib/delverPseudocode` | | |
| Native decompiler process | `planned` | `delver/delver-decompile` | | |
| Raw p-code | `planned` | `delver/delver-decompile` | | |
| Minidump provider | `planned` | `delver/provider-dump` | Full-dump kernel objects | |

## P3 — AI core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| LM tool registration | `planned` | `contrib/delverAI` | | |
| Proposal layer + review | `planned` | `contrib/delverAI` | | |
| Evidence chain UI | `planned` | `contrib/delverAI` | | |
| DTP session endpoint | `planned` | `services/delver/` | | |
| Python client | `planned` | `delver/clients/python` | | |
| Investigation notebooks | `planned` | `contrib/delverAI` | | |
| Eval harness | `planned` | `delver/corpus` | | |

## P4+ — Runtime and beyond

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| D0 non-invasive attach | `planned` | `delver/provider-winproc` | **Pull forward if packed malware dominates** | |
| Memory-vs-disk diff | `planned` | `contrib/delverMemory` | Same | |
| D1 debug loop | `planned` | `delver/provider-winproc` | | |
| D2 breakpoints/stepping | `planned` | `delver/provider-winproc` | Hardware BPs, WOW64 (P6) | |
| Region lifecycle timeline | `planned` | `contrib/delverMemory` | | |
| Type system | `planned` | — | | |
| CFG view | `planned` | `contrib/delverGraph` | | |
| Recipes / knowledge base | `planned` | — | Schema stub lands in P1 | |
