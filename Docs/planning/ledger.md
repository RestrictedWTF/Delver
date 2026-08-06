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
| Delver target service | `done` | `src/vs/workbench/services/delver/` | | |
| Build integration | `done` | `build/gulpfile.delver.ts`, `package.json` | | |
| Protocol codegen (Rust → schema → TS) | `done` | `delver-protocol/src/bin/gen-schema.rs`, `build/lib/delver/generate-protocol.ts` | Repaired 2026-08-07: the TS emitter was a hardcoded string and the schema only carried the envelope, so no payload type had ever been generated | |
| Branding + CI | `planned` | `product.json`, `build/`, `resources/` | Icons, installer artwork, Linux packaging — see [rebranding-plan.md](rebranding-plan.md) | |
| Theme (`theme-delver`) | `planned` | `extensions/theme-delver` | Product icon + file icon themes deferred | |

## P1 — Static core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| Named-pipe / Unix-socket transport | `done` | `delver/delver-rpc` | TCP transport; see also P0 `delver-rpc` row | [0003](../history/adr/0003-unsafe-code-in-transport-listener.md) |
| Imports / exports / seeds over DTP | `done` | `delver/provider-file`, `delver/delver-protocol` | Not surfaced in the UI until Stage G | |
| PE loader (`delver-format`) | `done` | `delver/delver-format` | Resource-directory *contents* (the directory itself is parsed); ELF and Mach-O (P5) | |
| Analysis server | `done` | `delver/server-analysis` | Progress notifications during indexing; multi-image sessions (one image at a time) | |
| Disassembly (`delver-disasm`) | `done` | `delver/delver-disasm` | Non-x86 architectures; instruction index is D5 | |
| Function detection | `done` | `delver/delver-analysis` | Signature matching (P5); sweep heuristics are deliberately naive — see status | |
| Analysis session host | `done` | `platform/delver/node/analysisSession.ts` | Progress reporting during indexing; one image per session | |
| Listing editor | `planned` | `contrib/delverListing` | Inline source interleaving (needs dynamic row heights) | |
| Xrefs | `done` | `delver/delver-analysis` | Graph query API (P6); indirect-call targets need dataflow | |
| Strings view | `planned` | `contrib/delverStrings` | | |
| Quick access (address/symbol/string) | `planned` | `contrib/delverListing` | | |
| Focus bus | `done` | `services/delver/common/delverFocusService.ts` | Thread/frame focus (P4); pin is per-view state, not bus state | |
| Interpretation layer | `planned` | `services/delver/common/` | Types (P5) | |
| `.delver` project | `planned` | `delver/delver-store` | | |
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
