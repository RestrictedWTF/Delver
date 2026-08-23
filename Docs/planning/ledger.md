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
| Branding + CI | `wip` | `product.json`, `build/`, `resources/`, `scripts/generate-artwork.py` | OS icons, installer artwork, and the in-workbench SVGs (titlebar app icon, editor watermark) all generate from `resources/delver/logo.png`. Remaining: Linux packaging, full `code.iss` file-association trim — see [rebranding-plan.md](rebranding-plan.md) | |
| Theme (`theme-delver`) | `planned` | `extensions/theme-delver` | Product icon + file icon themes deferred | |

## P1 — Static core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| Named-pipe / Unix-socket transport | `done` | `delver/delver-rpc` | TCP transport; see also P0 `delver-rpc` row | [0003](../history/adr/0003-unsafe-code-in-transport-listener.md) |
| Imports / exports / seeds over DTP | `done` | `delver/provider-file`, `delver/delver-protocol` | Exports and seeds are not surfaced in the UI yet — see [stage-g-plan.md](stage-g-plan.md) | |
| Imports view | `done` | `contrib/delverImports` | Delay-load imports shown as ordinary ones; no grouping by suspiciousness. Filter searches modules, symbols, ordinals, and IAT RVAs and remains reachable with zero matches. Addressed rows expose Rename/Comment/Tags | |
| Functions view | `done` | `contrib/delverFunctions` | Filter searches all functions and remains reachable with zero matches; bounded lazy pages replace the old 1,000-result ceiling without materializing 178k tree items. Function rows expose Rename/Comment/Tags | |
| Overview view | `done` | `contrib/delverOverview` | Rows navigate to the entry point, listing, Functions, References, and Strings. Hashes, compile timestamp, entropy, packer hints remain deferred | |
| PE loader (`delver-format`) | `done` | `delver/delver-format` | Resource-directory *contents* (the directory itself is parsed); ELF and Mach-O (P5) | |
| Analysis server | `done` | `delver/server-analysis` | Progress notifications during indexing (no longer urgent: 88.5 MB image analyses in ~3.9 s after the 2026-08-07 indexing work); multi-image sessions (one image at a time) | |
| Disassembly (`delver-disasm`) | `done` | `delver/delver-disasm` | Non-x86 architectures; instruction index is D5 | |
| Function detection | `done` | `delver/delver-analysis` | Signature matching (P5); sweep heuristics are deliberately naive — see status | |
| Analysis session host | `done` | `platform/delver/node/analysisSession.ts` | Progress reporting during indexing; one image per session | |
| Listing editor | `done` | `contrib/delverListing` | Wrapped source/pseudocode interleaving (needs truly dynamic row heights); **full-file scrollbar** — the buffer slides, see status; xref columns, context menu, and byte column. Authored names are bounded header lines; comments follow operands inline. Mouse4/Mouse5 use focus history | |
| Analysis service (renderer ↔ shared process) | `done` | `platform/delver/{common,node,electron-browser}/delverAnalysisService.ts` | Session reuse between sections view and listing — each opens its own provider today | [0001](../history/adr/0001-wire-protocol-framing-and-encoding.md) |
| Xrefs | `done` | `delver/delver-analysis` | Graph query API (P6); indirect-call targets need dataflow | |
| References view | `done` | `contrib/delverXrefs` | Filtering by kind. Rows and headings use live `function+offset` labels when bounds prove ownership, and expose Rename/Comment/Tags | |
| Follow / return traversal | `done` | `contrib/delverListing` | Following a data reference into a hex view (needs the hex view); operand-level links for non-branch operands | |
| Strings view | `done`, navigation follow-up planned | `contrib/delverStrings` | Editor page with filter and encoding column is built. Scan cap stays at 200k and reports truncation. After the current decompiler phase, double-click should navigate to the string RVA in a read-only `.rdata`/`.data` section viewer; do not start that pane during P2 decompiler stabilization | |
| Exports view | `done` | `contrib/delverExports` | Filtering; forwarded exports are shown but not navigable. Addressed exports expose Rename/Comment/Tags | |
| Navigation (address/function/history) | `done` | `contrib/delverListing/browser/delverListingNavigation.ts` | Go to String — quick-pick scale plus the 200k string cap; belongs with the strings view. Named symbols need the interpretation layer | |
| Session registry | `done` | `services/delver/common/delverSessionService.ts` | Multiple concurrent sessions — one active session at a time | |
| Focus bus | `done` | `services/delver/common/delverFocusService.ts` | Thread/frame focus (P4) | |
| Per-view pin | `done` | `contrib/delverListing/browser/delverListingContext.ts` | Not persisted across reloads; only the listing has one so far. Pin is per-view state, never bus state, and keys on focus *reason* — see status | |
| Interpretation layer | `done` | `platform/delver/common/interpretation.ts`, `services/delver/common/delverInterpretationService.ts` | Persistent inline names/comments/tags; append-only undo and revert-by-author; actions on all meaningful RVA rows. Types (P5); merge and conflict detection (P6) | |
| Proposal review state | `done` | `platform/delver/common/interpretation.ts`, `services/delver/common/delverInterpretationService.ts`, `contrib/delverAI/browser/delverReview.contribution.ts` | Proposals are appended `proposed`, stay out of the materialized view, and are decided by a later append carrying `resolves`. The Review view exposes individual human Accept/Reject actions and location navigation. Batch review validates every sequence before appending anything. Threshold/bulk UI remains later polish | [0006](../history/adr/0006-proposal-resolution-in-the-edit-log.md) |
| Content hash (image identity) | `done` | `delver/provider-file` | Normalized hashing for in-memory images, which P4 needs so a loaded module matches its on-disk counterpart | |
| Function revision matcher | `done` | `platform/delver/common/functionRevisionMatcher.ts` | Pure TypeScript exact matching over explicit normalized fingerprints. Listing normalization ignores row/RVA relocation and canonicalizes direct targets; exact matches require uniqueness and expose confidence, method, and provenance. Structural fuzzy matching and automatic interpretation transfer remain deliberately unimplemented | |
| Legacy interpretation store | `done`, **superseded design** | `platform/delver/{common,node,electron-browser}/delverInterpretationStoreService.ts` | Current implementation is append-only JSONL in user data, keyed by content hash. It remains the migration source until the portable project replaces it; do not extend this format. The shared edit record gained `resolves` for ADR 0006 — a field the log carries, not a new store capability | [0004](../history/adr/0004-interpretation-store-location.md), [0005](../history/adr/0005-portable-project-database.md) |
| Portable `.delverdb` project | `wip` | `platform/delver/node/delverProjectStoreService.ts`, `services/delver/common/delverProjectService.ts` | Schema v5 is a single shareable SQLite analysis DB for functions, strings, facts, pseudocode, interpretation, range-backed findings, append-only finding decisions, bounded tool-call request/result records, provenance, revisions, and session state. It excludes sample bytes and opens without the sample. Raw targets start untitled; dirty close/replacement/shutdown prompts Save / Don't Save / Cancel; saved projects autosave incrementally | [0005](../history/adr/0005-portable-project-database.md) |
| Golden corpus | `done` | `delver/corpus` | Real-binary samples: F4 forbids non-redistributable ones, so samples are synthesised. Local-only real binaries by path are not wired up yet | |
| Hex view | `planned` | `contrib/delverMemory` | **Slidable to P4** — nothing in P2/P3 needs it | |

## P2 — Decompilation & p-code

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| `IDecompilerService` | `wip` | `services/delver/common/delverDecompilerService.ts` | Contract, configured shared-process bridge, cancellation, variables, bidirectional line↔RVA mapping, strict versioned Ghidra JSON decoding, and the pseudocode editor consumer are built. The configured Windows path has passed a real headless smoke test. The contract is becoming backend-neutral so PyGhidra and future IDALib/Hex-Rays workers do not leak into the UI | |
| Ghidra headless fallback | `wip` | `platform/delver/node/ghidraHeadlessDecompiler.ts`, `scripts/ghidra/DelverDecompile.java` | Pinned to Ghidra 12.1. Safe cross-platform launch, verified target snapshots, temporary-project cleanup, cancellation, high variables, and line provenance are built. It is now selected explicitly with `delver.decompiler.backend`; PyGhidra failures never trigger a hidden slow request | |
| Pseudocode editor | `wip` | `contrib/delverPseudocode` | Read-only `delver-pseudo:` Monaco page and Functions navigation are built. It deliberately uses the existing `c` mode so the C grammar, folding, find, and editor contributions work immediately. Rename/comment editing remains later P2 work | |
| Line ↔ address map | `wip` | `contrib/delverPseudocode`, `contrib/delverListing` | Cursor lines publish first-instruction focus, a compatibility bounding selection, and exact discontiguous half-open ranges. The virtualized listing paints only instructions overlapping those ranges, including rows loaded after the focus change; external RVA focus selects the first matching pseudocode line | |
| Backend-neutral decompiler host protocol | `wip` | `platform/delver/node/decompilerWorkerHost.ts`, `scripts/ghidra/delver_decompiler_worker.py` | Versioned JSON-lines handshake, lifecycle, multiplexing, cancellation, structured errors, capabilities, actual backend/version/adapter/generation, startup diagnostics, and phase timings are built. Backend recovery UI and future IDA coverage remain | |
| Persistent PyGhidra worker | `wip` | `platform/delver/node/pyGhidraDecompiler.ts`, `scripts/ghidra/delver_decompiler_worker.py` | One JVM and Program/DecompInterface are retained across function requests. Persistent projects are cached in local user data by content hash, Ghidra version, and analysis profile, separately from portable `.delverdb`. Live sessions background worker startup and verified project/program import; concurrent F5 joins the same content-qualified target open. Cold functions still use on-demand recovery instead of blocking F5 on full-program auto-analysis. Generated `FUN_<VA>` identifiers are presented as stable `SUB_<RVA>` names without mutating Ghidra's Program. Headless is explicit, never a silent fallback | [0005](../history/adr/0005-portable-project-database.md) |
| Project/decompiler read-through integration | `wip` | `services/delver/common/delverSessionService.ts`, `services/delver/common/delverProjectService.ts`, `services/delver/common/delverDecompilerService.ts` | Open Project restores snapshot-backed panes and automatically attaches a normalized saved source path only when it remains inside the current workspace and its SHA-256 matches. Offline fallback, hash-verified Locate Target, exact saved-pseudocode lookup, provenance, request coalescing, atomic re-decompile, honest backend state, explicit backend selection, recovery controls, native-cache cleanup, and phase timings are built. Background full-analysis progress remains | [P2b integration plan](p2b-project-decompiler-integration-plan.md) |
| IDALib/Hex-Rays worker | `planned` | `scripts/ida/` | Python IDALib (`idapro`) worker targeting user-provided IDA Pro 9.0+ and Hex-Rays. It serializes every database call on the initialization thread, adapts decompilation and ctree/eamap provenance into the common result, and keeps a content-hash/version/profile-qualified IDB outside `.delverdb`. Hard cancellation may restart the isolated worker. Discovery reports installation, IDALib, architecture, and decompiler-license failures separately; no IDA redistribution | |
| Native Ghidra responder | `deferred` | `delver/delver-decompile` | Optional only if persistent PyGhidra profiling proves native integration worth its version-coupling cost | |
| Backend-specific IR | `planned` | decompiler worker adapters | Ghidra p-code and Hex-Rays microcode/ctree stay optional capabilities; no lossy pretend-common IR | |
| Minidump provider | `planned` | `delver/provider-dump` | Full-dump kernel objects | |

## P3 — AI core

| Feature | Status | Code | Deliberately not done | ADR |
| --- | --- | --- | --- | --- |
| Agent capability contract | `done` | `services/delver/common/delverAgentTypes.ts` | Versioned JSON-safe envelope, thirteen stable error codes, output limits, revision-bound opaque cursors, and `"0x..."` address parsing/normalization. `INVALID_ARGUMENT` covers malformed requests; valid but unmapped addresses remain `ADDRESS_NOT_MAPPED`. JSON numbers above 2⁵³ are rejected rather than silently mistruncated | |
| Agent capability dispatcher | `wip` | `services/delver/common/delverAgentService.ts` | Twenty-one capabilities: bounded raw image/file byte reads plus the prior sixteen read/UI operations and attributed, review-only rename/comment/tag proposal batches with durable evidence-backed findings. Authoring batches are bounded and fully validated before retention, work for offline projects, and never materialize as accepted interpretation. Session resolution, attachment checks, pagination, limits, cancellation, provenance, untrusted labelling, and per-stage latency measurements happen once for every caller. A per-content-hash function index keeps focus resolution off the 178k-row snapshot parse. **Deliberately not done:** byte and instruction search, blocks/CFG/paths, globals and types (P3d) | |
| LM tool registration | `wip` | `contrib/delverAI` | Direct in-workbench path over `ILanguageModelToolsService` in a `delver-analysis` tool set; it does not traverse MCP. Tool schemas are generated from the dispatcher's capability list so the chat picker cannot advertise a capability the dispatcher lacks | |
| Proposal layer + review | `wip` | `platform/delver/common/findings.ts`, `platform/delver/common/delverToolCall.ts`, `services/delver/common/delverProjectService.ts`, `contrib/delverAI` | Rename/comment/tag tools and `delver_report_finding` retain attributed provisional work. The Review view shows both queues and appends human decisions; finding decisions and cited prior tool calls survive offline reopen in schema v5. Bulk review remains | |
| Evidence chain UI | `wip` | `contrib/delverAI/browser/delverReviewView.ts`, `contrib/delverAI/browser/delverToolCallContentProvider.ts` | Described finding ranges are expandable and focus-bus navigable; cited persisted tool calls appear as children and open a read-only JSON request/result document. Graph-path edges and richer filtering remain | |
| External agent bridge | `wip` | `contrib/delverAI/browser/delverAgentGateway.contribution.ts`, `extensions/delver-agent-bridge`, `delver/agent-bridge-relay`, `delver/delver-mcp` | The two-command gateway, bounded DTP connection, owner-only relay, kernel peer attestation, one-shot authorization prompt, bootstrap manager, protected non-secret registry, root-v1 routing, per-window lifecycle, and native MCP stdio adapter are production-composed. The adapter requires an explicit root, discovers schema-bearing tools lazily, maps cancellation to DTP, and preserves structured Delver results without duplicating analysis. `onStartupFinished` remains inert for untrusted, remote, virtual, untitled, unsupported, zero-root, and multi-root windows. Root rotation and shutdown close pending and authenticated private relays before applying a new scope and await native/registry cleanup. The published integration surface is `Docs/development/external-agents.md` plus a **Copy External Agent (MCP) Configuration** command that resolves the staged adapter and the window's single root, or names the one reason the window is ineligible, from the same gate activation uses. Remaining: real-client/cross-transport conformance, progress/list-change events, and latency measurement. Connecting never opens or reanalyses a target | |
| DTP session endpoint | `wip` | `extensions/delver-agent-bridge`, `delver/agent-bridge-relay`, `delver/delver-rpc` | Bounded protocol/authentication/cancellation, raw current-user pipe/socket relay, kernel peer attestation, one-shot explicit authorization, race-safe bootstrap publication, protected non-secret registry storage, atomic endpoint-generation-bound token leases, root-v1 routing, explicit lifecycle outcomes/backoff, and real process conformance are active for eligible local windows. Windows reserves the first local-only pipe instance, audits the registry DACL, and preserves duplex progress across synchronous duplicated handles; Unix validates private owner directories and refuses collisions. Private DTP relays are one-shot and root-scoped; extension deactivation waits for child exit and endpoint cleanup | |
| Complete MCP session | `wip` | [completion plan](mcp-complete-session-plan.md) | Ordered closure after transport: retained proposals/findings, raw data/search, program graphs, semantic refinement, guarded corrections, and durable investigations | |
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
