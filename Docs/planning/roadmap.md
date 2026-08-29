# Roadmap

Two tracks, run in this order of priority:

- **Core track** — the shortest path to something you and the team actually use.
  Every phase ends with a working tool, not a layer.
- **Depth track** — the deep and complex work in the same areas, deliberately
  deferred so it never blocks the prototype.

**Priority: static reverse engineering with decompilation and AI, first.**
Runtime and the debugger come after. The reasoning is that decompiled C is what
makes AI grounding work (see §"Why decompilation before runtime" below), and
static file analysis is the team's day-to-day need.

Sizes are relative effort (S / M / L / XL), not calendar time — team size and
availability decide that.

---

## Phase map

| Phase | Core deliverable | Notes |
| --- | --- | --- |
| **P0** Skeleton | End-to-end pipe: IDE ↔ provider ↔ a real PE | |
| **P1** Static core | **The prototype.** Listing, navigation, annotation | Prerequisite for P2 — the decompiler needs it |
| **P2** Decompilation & p-code | Pseudocode synced to the listing | Largest single integration in the roadmap |
| **P3** AI core | Grounded tools, proposals, evidence, notebooks | The payoff for P2 |
| **P4** Runtime & debugger | Live attach, basic debugger, memory-vs-disk diff | [09-Debugger-PoC.md](../architecture/debugger-provider.md) |
| **P5** Analysis depth | Types, CFG, ELF/Mach-O, signatures | Depth track |
| **P6** Scale & knowledge | Recipes, graphs, more providers, hardening | |
| **P7** Kernel & hypervisor | **PARKED** until the abstraction has survived 3+ providers | |

---

# P0 — Walking skeleton

Prove the whole pipe end to end with the least code possible. Nothing
user-facing beyond a debug view.

## Core

| Item | Size | Notes |
| --- | --- | --- |
| `delver/` Rust workspace | S | Mirrors the existing `cli/` crate. See [08-Project-Structure.md](../architecture/project-structure.md) |
| `delver-protocol` + codegen to TS | M | Rust is the source of truth; TS is generated and checked in |
| `delver-rpc` transport (JSON-RPC + binary frames) | M | stdio first |
| `provider-file`: open a PE, return headers/sections | M | `goblin` or `object` crate |
| `providerProcess.ts` host in the workbench | M | Modelled on how debug adapters are spawned |
| One throwaway view listing sections | S | Proof of life, deleted in P1 |
| `delverctl` headless harness | S | Drives the protocol without the IDE |
| Branding, telemetry off, CI (build + typecheck + layers) | M | |

**`delverctl` matters more than it looks.** It lets the analysis engine be
developed and tested with zero IDE involvement, makes the golden corpus runnable
in CI, and gives the team headless triage for free.

## Load-bearing decisions (cheap now, brutal later)

- `ILocation` / `IMoment` in every read signature, including the file provider
  where the Moment is constant.
- The **process boundary** between renderer and parser. Keep it from day one.
- **Sandboxing that boundary is not required in P0.** Hardening is a token/flag
  change you add in P4. The boundary is architectural; the sandbox is
  configuration. Don't conflate them and slow yourself down.
- Fact vs. interpretation as separate stores, even when interpretation is empty.
- `Anchor` as `(contentHash, rva)`, never absolute addresses.

**Exit:** `delverctl sections notepad.exe` and the IDE both get the same data
from the same provider process.

---

# P1 — Static core · **the prototype**

Everything the decompiler needs, plus a tool that stands on its own if P2 slips.

Do not try to skip this to reach decompilation faster. The Ghidra decompiler
queries back for **bytes, function boundaries, and symbols** — the responder in
P2 is built on exactly what P1 produces.

## Core

| Item | Size | Notes |
| --- | --- | --- |
| PE loader: sections, imports, exports, relocs, resources, TLS, entry | M | ELF/Mach-O deferred to P5 |
| `server-analysis` process | M | Separate from providers |
| Disassembly via `iced-x86`, windowed decode | M | Never decode a whole module |
| **Function detection** — linear + recursive descent, exports and exception-directory entries as seeds | M | **P2 depends on this** |
| **Listing editor** — `EditorPane` + `WorkbenchTable` | L | Copy the pattern from `contrib/debug/browser/disassemblyView.ts` |
| Xrefs (code + data), both directions | M | Sorted index tables, not objects |
| Strings view | S | ASCII + UTF-16; filter, sort, xref-to |
| Imports/exports/sections trees | S | |
| Quick access: go to address / symbol / string | S | Very high value per line of code |
| Address history on Alt+Left / Alt+Right | S | Free once views are `EditorInput`s |
| Focus bus with `origin` tagging + per-view pin | M | Prevents update loops from day one |
| Rename, comment, tag — anchored, attributed, undoable | M | The append-only edit log. **P2 writes through this** |
| Portable `.delverdb` SQLite project | M | Untitled raw-binary session; Save / Don't Save / Cancel when dirty; named projects autosave; opens without target; excludes sample bytes |
| Outline view = function list | S | |
| Golden corpus + regression suite in CI | M | Start it here or it never starts |

## Can slide out of P1 if you want P2 sooner

- **Hex view** (M) — genuinely useful, but nothing in P2 needs it. Slide to P4
  where it pairs with live memory. A smaller post-P2 read-only data-section
  viewer may land first: double-clicking a Strings row should open `.rdata` or
  `.data` at that string's RVA, with address history and focus-bus integration.
- Resource and TLS parsing — entry points and code matter first.

## Explicitly not in P1

Types/structs · CFG or any graph · signature matching · ELF/Mach-O ·
demangling beyond MSVC basics · multi-architecture · YARA search · any AI ·
capability-negotiation UI · the graph query API · recipes beyond a schema stub ·
sandboxing.

**Exit:** an analyst opens an unknown PE, navigates it by symbol and address,
reads the disassembly, names 30 functions, writes comments, closes it, reopens it
tomorrow, and everything is there.

---

# P2 — Decompilation and p-code · **the new priority**

The largest single integration in the roadmap. Staged so the product questions
get answered before the expensive engineering, without coupling the workbench to
one decompiler engine.

## Why this is staged

Ghidra and IDA expose different lifecycles, data models, and intermediate
representations. Ghidra is most directly automated through PyGhidra, which owns
a long-lived JVM and Ghidra project. For IDA Pro 9.0+, the preferred integration
is a separate Python worker using IDALib (`idapro`) to run the existing
IDAPython and Hex-Rays APIs outside the GUI. Both require installed, licensed
user environments and must not share a runtime.

The durable boundary is therefore a **backend-neutral decompiler host protocol**,
not a Ghidra library API. The host supervises one isolated worker per engine.
PyGhidra is the first production adapter; a separate IDALib/Hex-Rays adapter can
follow without changing the workbench or pseudocode editor. A native Ghidra
responder remains an optional optimization if profiling later justifies its
maintenance cost.

## P2a — Headless proving path

| Item | Size | Notes |
| --- | --- | --- |
| Headless Ghidra script → `{C text, address↔line map, variables}` as JSON | S | Compatibility fallback after P2b |
| `IDecompilerService` interface + headless backend behind it | M | The backend-neutral interface survives |
| `delver-pseudo:` scheme + `delver-c` language in Monaco | M | Free highlighting, folding, find, peek |
| **Line ↔ address map**, bidirectional sync with the listing | M | This is the feature; text rendering is free |
| Rename/comment in pseudocode writes through to the interpretation layer | M | |

**Exit of P2a:** click a pseudocode line, the listing highlights the matching
instructions; rename in either view and both update. You now know whether
AI-on-decompilation works for your samples — before paying for P2b.

## P2b — Persistent backend-neutral decompiler host

Implementation sequencing and acceptance tests are defined in the
[P2b Project and Decompiler Integration Plan](p2b-project-decompiler-integration-plan.md).

| Item | Size | Notes |
| --- | --- | --- |
| Project/session lifecycle | M | Raw binaries open untitled; prompt Save / Don't Save / Cancel on close, target replacement, and shutdown only after durable analysis content exists |
| Portable SQLite `.delverdb` | L | One shareable analysis file containing facts, pseudocode, interpretation, findings, provenance, and restorable session state; never sample bytes |
| Incremental autosave + migration | M | Named projects commit durable changes transactionally; migrate the current per-hash interpretation JSONL without losing append-only history |
| Exact function revision matcher | S | Versioned normalized listing fingerprints; unique exact matches expose confidence/method/provenance; duplicates stay ambiguous |
| Structural fuzzy revision matcher | M | **Follow-up.** CFG/call-shape/string evidence with disclosed lower confidence; never guess by RVA/size or silently move authored edits |
| Versioned host protocol + capability handshake | M | Backend identity/version, architectures, decompilation, mappings, variables/types, cancellation, persistence, and optional IR capabilities |
| Persistent PyGhidra worker | M | Start one JVM, retain the analyzed project/program, and decompile many functions |
| Backend discovery and selection | S | Report missing Ghidra/IDA installations, incompatible versions, and unavailable Hex-Rays licenses explicitly |
| Persistent per-engine analysis state | M | A local content-hash-keyed Ghidra project now; an IDA database when its adapter lands. Both are disposable, nonportable accelerators outside `.delverdb` |
| Keep the headless Ghidra backend as a fallback | S | Recovery and compatibility path, not the normal per-function path |
| Caching + invalidation keyed by content hash, backend/version, analysis profile, schema version, and edit log | M | Never reuse output across incompatible engines, schemas, or analysis settings |
| Decompiler timeout / failure handling as first-class UI state | S | Big obfuscated functions will fail. Say so, don't hang |

The common result schema owns only semantics the UI can rely on: backend
identity and version, function identity, pseudocode text, recovered variables,
diagnostics, and line↔RVA mappings. Ghidra p-code and Hex-Rays microcode/ctree are
advertised and returned as optional backend-specific capabilities. Do not invent
a lossy common IR just to make the field names match.

The portable project is the record of analysis and user work. Backend-native
state is only an accelerator: deleting the local Ghidra/IDA cache may make the
next analysis slow, but must not remove anything the user authored or prevent a
`.delverdb` from opening without the sample. See
[session-persistence.md](../architecture/session-persistence.md).

## P2c — IDA/Hex-Rays adapter

| Item | Size | Notes |
| --- | --- | --- |
| Separate IDALib Python worker | M | Import `idapro` first, then use IDAPython/Hex-Rays outside the GUI in the user's configured IDA Pro 9.0+ installation; never import it into the PyGhidra process |
| Serialized database lifecycle | S | IDALib is single-threaded and requires database calls on its initialization thread. Queue requests in the worker; hard cancellation may terminate and restart that worker |
| Hex-Rays decompilation and mappings | M | Initialize Hex-Rays explicitly, call `ida_hexrays.decompile`, strip tagged pseudocode, and adapt variables, diagnostics, ctree/eamap-derived line/address provenance into the common schema |
| IDA database persistence and invalidation | M | Reuse a content-hash-keyed IDB only when IDA, decompiler, processor/loader options, and analysis-profile versions match |
| Discovery and license/capability reporting | S | Discover or accept an explicit IDA path and distinguish missing IDA, incompatible IDALib, missing Hex-Rays, and unsupported architecture/decompiler licenses |
| Worker conformance test double | S | Prove handshake, serialization, cancellation/restart, malformed-output handling, and cache identity in CI without requiring IDA; run licensed smoke tests separately |

IDA and Hex-Rays remain optional user-provided integrations. Delver does not
bundle or redistribute them. The first adapter uses Python IDALib rather than
linking IDA into the Electron process: it preserves process isolation and gives
access to the full IDAPython API with much less ABI and packaging work. The C++
IDALib/IDA SDK remains a later escape hatch for measured API or performance
limits; it does not change the host protocol. Product/server embedding must be
reviewed against the applicable IDA/OEM license rather than inferred from local
developer use.

Primary references: [IDALib](https://docs.hex-rays.com/user-guide/idalib),
[IDALib lifecycle and threading](https://cpp.docs.hex-rays.com/idalib_8hpp.html),
and [Hex-Rays IDAPython API](https://python.docs.hex-rays.com/ida_hexrays/index.html).

## p-code

| Item | Size | Notes |
| --- | --- | --- |
| Expose raw p-code per instruction/block | M | SLEIGH lifting; a C++ FFI dependency if done natively |
| Expose refined p-code from Ghidra | S | Optional PyGhidra capability; never required of other backends |
| p-code query surface for semantic passes | M | |

**Ranking for AI grounding: C ≫ refined p-code > assembly ≫ raw p-code.**
Raw p-code is verbose and low-level — useful for your own analysis passes, bad
as a model input. Do not feed it to an LLM.

## Cheap insurance — a second provider

| Item | Size | Notes |
| --- | --- | --- |
| **Minidump provider** | M | A file parser: no debug loop, no thread affinity |

With the debugger deferred to P4, `ITargetProvider` would otherwise go unvalidated
until late — and a one-implementation abstraction is always wrong. Minidump is
the cheapest fix: it exercises threads, registers, modules, and multiple address
spaces, and "open a crash dump" is a real static workflow on its own.

**Exit of P2:** decompiled C for an arbitrary function, synced to the listing,
with renames flowing both ways and repeated requests served by a persistent,
discoverable backend. Adding IDA/Hex-Rays changes an adapter, not the workbench.

---

# P3 — AI core

Now the model has something worth reading. See [05-AI-Analyst.md](../architecture/ai-analyst.md).
The implementation sequence, direct-versus-external transport boundary, tool
catalog, latency budgets, and large-binary investigation memory are specified in
the [P3 AI integration plan](ai-integration-plan.md).

| Item | Size |
| --- | --- |
| Tools registered with `ILanguageModelToolsService`, bounded and Moment-tagged | M |
| Decompilation as the primary AI input, with the listing as backup | S |
| Proposal layer + batch review surface | L |
| Evidence chain UI — click a claim, see tool calls and byte ranges | M |
| Local DTP endpoint + `DELVER_SESSION` handoff, token-authed | M |
| **Python client** (`delver` package) | M |
| Investigation notebooks (`.delvernb`) | L |
| UI ops over the protocol (`report_finding`, `focus`, `annotate`) | S |
| Untrusted-content handling + injection detection | M |
| Eval harness on the golden corpus, in CI | M |

**Exit:** the model reads decompiled output for an unfamiliar routine, proposes
30 renames and a finding, the analyst reviews them in one pass, and every
accepted claim traces to bytes. Grounding and hallucination rates are measured,
not asserted.

---

# P4 — Runtime and debugger

Deferred, not dropped. This is where packed samples become tractable.

| Item | Size | Notes |
| --- | --- | --- |
| **D0** — non-invasive attach: memory, modules, threads, regions, registers | M | ~300 lines. [09-Debugger-PoC.md](../architecture/debugger-provider.md) |
| **Memory-vs-disk image diff** in the diff editor | M | Needs only D0. Finds inline hooks and unpacked sections |
| Image normalization (undo relocs, zero IAT) | M | Powers the diff and anchor matching |
| Hex view (if slid from P1) | M | |
| Real `Moment` handling: Live vs. Frozen, staleness indicators | M | First time this is exercised for real |
| Runtime views: processes, threads, modules, regions, handles | M | |
| **D1** — invasive debug loop, halt/resume, module + thread events | M | Thread-affine loop |
| **D2** — software breakpoints, single step, call stack | L | |
| Region lifecycle recording → Timeline (alloc → write → +X → exec) | M | |
| Provider sandboxing + restart-on-crash | M | |
| Capability gating for real, with `when` clauses | S | Three providers makes this concrete |

## Deferred to P6

Hardware breakpoints · conditional breakpoints · watchpoints · WOW64 / 32-bit
targets · trace recording · anti-anti-debug · DAP shim.

**Exit:** attach to a running process, freeze it, diff a loaded module against
its file on disk, and land on a real inline hook. Adding providers required
**zero changes** to `ITargetProvider` — if it did, fix the abstraction before P5.

---

# P5 — Analysis depth

| Item | Size |
| --- | --- |
| Type system: structs, enums, function signatures, propagation | XL |
| ~~Type application feeding back into the decompiler responder~~ — **done** | L |
| CFG per function with layered layout | L |
| Stack frame / local variable recovery beyond what the decompiler gives | L |
| ELF and Mach-O loaders | L |
| Signature matching for library code | L |
| **Entry-point role recovery — started, incomplete** | M |
| Demangling (MSVC, Itanium) | M |

Accepted data types and function prototypes already reach the decompiler: they
travel with each request as a versioned snapshot, PyGhidra applies them inside a
rolled-back transaction, and the snapshot is part of decompilation identity so no
cache can serve text built against a superseded type model
([ADR 0013](../history/adr/0013-accepted-semantics-as-decompilation-input.md)).

**Entry-point role recovery is half-built and does not work yet.** What landed:
the PE `Subsystem` is parsed and carried (exact), and the image entry point is
labelled as the C runtime stub rather than presented as the user's entry —
useful, since it is the difference between "your code starts here" and "this is
scaffolding". What did *not* land is finding `main`/`WinMain` behind it.
`delver-analysis/src/entry_role.rs` holds a call-graph walk for the MSVC startup
shape; it is written, tested, fails closed, and **resolved 0 of 80 real
System32 binaries** — every one declined to the CRT entry alone. Two heuristics
were falsified against real samples rather than reasoned about:

- The startup path is a **fan-out, not a chain of forwarders**. `mainCRTStartup`
  branches to the security-cookie init and the CRT frame; the frame then calls
  six or more helpers with `main` among them. A walk that follows single calls
  stops immediately.
- "The call between `_initterm` and `exit`" fails because **address order is not
  execution order** — on `where.exe` the `exit` call sits *below* the `_initterm`
  call. It would need control flow, which the walk does not use.
- On newer binaries the CRT is statically linked, so there are no marker imports
  to anchor on at all.

The real answer is the row above it: recognize the CRT functions themselves by
**signature**, which is what other tools do and which Delver already has the
machinery for — named signatures carry retained proofs and match across
revisions. The walk is kept because it is correct on the shapes it does
recognize, never produced a false positive across those 80 samples, and would
otherwise be rebuilt from scratch when signatures land. It must not be described
as working until it does.

---

# P6 — Scale, knowledge, hardening

| Item | Size |
| --- | --- |
| Recipes: compile an investigation into a re-runnable rule | XL |
| Call graph (neighborhood-first) and object graph | L |
| Byte / regex / YARA search viewlet | M |
| Emulator provider | L |
| Debugger depth items deferred from P4 | L |
| Fuzzing all parsers, continuously in CI | M |
| Remote-provider deployment mode documented and supported | M |
| Script-runner contrib: registered Python scripts on workspace events | M |
| TypeScript extension API — **only** if a UI-contributing plugin is genuinely needed | L |

---

# P7 — Kernel and hypervisor · **PARKED**

Kernel debugger provider first (validates virtual↔physical translation and kernel
object enumeration), then the hypervisor.

**Exit:** the hypervisor provider is added without changing `ITargetProvider`.
`MomentKind.Replay` activates for time travel with no data-model change — it was
designed in at P0.

---

## Why decompilation before runtime

The case for this ordering:

- **AI grounding depends on it.** A model reasoning over decompiled C is a
  different product from one reasoning over disassembly. Since the AI analyst is
  the differentiator, the input quality gates everything downstream.
- **It matches the team's actual work** — static analysis of files on disk.
- **P1 + P2 is a complete tool.** Runtime adds a capability; it isn't a
  prerequisite for value.

The honest cost:

- **Packed malware stays hard until P4.** Decompiled C for a packed sample is
  garbage until you've dumped it unpacked, and the memory-vs-disk diff and
  unpacking timeline are the features that make that tractable. If the team's
  work turns out to be mostly packers and injectors rather than general RE, pull
  D0 and the diff forward out of P4 — they're M-sized and depend on nothing in
  P2 or P3.
- **P2 is the hardest phase and it's early.** Mitigated by P1 standing on its
  own and by the P2a scaffold getting value out before the expensive part.

## Three decisions that carry the most weight

1. **`Moment` in P0.** Retrofitting a time axis touches every service signature
   and every cache key. Free now, near-impossible later.
2. **A second provider before P7.** Minidump in P2 is the cheap way to keep this
   honest while the debugger is deferred.
3. **Finding / Recipe schemas in P1, unused.** The knowledge base is the moat and
   can only be built from data captured all along.

## Anti-goals

Not competing on best-in-class decompilation (integrate it), breadth of
architectures (x86/x64 deeply first), plugin count, or being a general-purpose
debugger.
