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
| `delver-rpc` transport | `done` | `delver/delver-rpc` | Named pipe and TCP transports — stdio only at first | |
| `provider-file` (PE headers) | `done` | `delver/provider-file` | ELF, Mach-O | |
| Provider process host | `done` | `src/vs/platform/delver/node/` | Sandboxing (deferred to P4) | |
| `delverctl` | `done` | `delver/delverctl` | | |
| Delver sections view | `done` | `src/vs/workbench/contrib/delverSections/` | | |
| Delver target service | `done` | `src/vs/workbench/services/delver/` | | |
| Build integration | `done` | `build/gulpfile.delver.ts`, `package.json` | | |
| Branding + CI | `planned` | `product.json`, `build/`, `resources/` | Icons, installer artwork, Linux packaging — see [rebranding-plan.md](rebranding-plan.md) | |
| Theme (`theme-delver`) | `planned` | `extensions/theme-delver` | Product icon + file icon themes deferred | |

## P1 — Static core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| PE loader | `planned` | `delver/delver-format` | Resources, TLS if sliding P1 | |
| Analysis server | `planned` | `delver/server-analysis` | | |
| Disassembly (`iced-x86`) | `planned` | `delver/delver-disasm` | Non-x86 architectures | |
| Function detection | `planned` | `delver/delver-analysis` | Signature matching (P5) | |
| Listing editor | `planned` | `contrib/delverListing` | Inline source interleaving (needs dynamic row heights) | |
| Xrefs | `planned` | `delver/delver-analysis` | Graph query API (P6) | |
| Strings view | `planned` | `contrib/delverStrings` | | |
| Quick access (address/symbol/string) | `planned` | `contrib/delverListing` | | |
| Focus bus | `planned` | `services/delver/common/focusService.ts` | | |
| Interpretation layer | `planned` | `services/delver/common/` | Types (P5) | |
| `.delver` project | `planned` | `delver/delver-store` | | |
| Golden corpus | `planned` | `delver/corpus` | | |
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
