# Critique and Direction

A review of [AI-Native-Reverse-Engineering-IDE-Vision.md](original-vision.md).
The vision is directionally right and the differentiators section is correctly
chosen. This doc records what survives contact with implementation, what breaks,
and what's missing.

---

## What to keep, unchanged

**"The AI is not the product. The workspace is the product."** This is the single
most valuable line in the document. Hold it. Every AI-for-RE product that has
failed did so by making the model the surface and the data an afterthought.

**Compete on live introspection + unified state + grounded AI, not on a better
decompiler.** Correct. You will never out-decompile Hex-Rays with a small team,
and you don't need to — decompilation is a commodity you integrate.

**"AI invokes structured tools rather than interpreting raw memory."** Correct and
non-negotiable. See [05-AI-Analyst.md](../architecture/ai-analyst.md).

**Synchronization as a core feature.** Right, but it needs an explicit mechanism —
see the `Moment` problem below.

---

## What breaks

### B1 — "Everything is represented as a graph" is a storage mistake

The graph is the right *mental* model and the wrong *storage* model.

A single 5 MB module is roughly 1.2–1.8 million instructions. A generic
node/edge store with property bags costs on the order of 150–250 bytes per node
once you include the map overhead, the ID, and the property dictionary. That's
300+ MB for one module before you store a single edge, and traversal becomes
pointer chasing across a fragmented heap. Open six modules and a kernel and the
workspace is dead.

**Direction:** materialize nodes above the basic-block level; compute edges below
it.

- Coarse entities — modules, functions, basic blocks, processes, threads,
  handles, kernel objects, memory regions, findings — are real, persisted,
  ID'd nodes. This is thousands to low hundreds of thousands of nodes. A graph
  is fine here and genuinely useful.
- Fine entities — instructions, bytes, individual xrefs — live in typed
  columnar arrays and sorted index tables. An xref "edge" is a row in a sorted
  `(from_addr, to_addr, kind)` table, answered by binary search, not a
  materialized object.

The graph API stays as the *query interface*. Callers still write
`graph.from(fn).out('calls')`. They just don't get an object per instruction.
Detail in [02-Data-Model.md](../architecture/data-model.md).

### B2 — There is no time axis, and "live first" requires one

"Everything is synchronized" and "live first" are in direct conflict as written.
On a live target, memory changes while you read it. If the registers view reads
at `t0`, the stack view at `t1`, and the disassembly at `t2`, the synchronized
workspace is showing you a state that never existed. That's worse than an
unsynchronized one, because it looks authoritative.

**Direction:** every read is parameterized by a **`Moment`** — a coherency epoch.
Views pin to a Moment. A "live" Moment auto-advances on target events; a frozen
one doesn't. Snapshots and, later, execution traces are just Moments with more
provenance. This costs almost nothing to add now and is nearly impossible to
retrofit — every service signature and every cache key depends on it.

It also means time-travel debugging drops in later without a redesign, because
replay is a Moment kind.

### B3 — The architecture is designed around the hypervisor

Layer 0 is the hypervisor, and everything above assumes its capabilities. This
guarantees that the abstraction is wrong, because an abstraction derived from one
implementation always is. It also means nothing is usable until the hardest
component works.

**Direction:** design the attach layer around **capability negotiation**, and
build the *weakest* provider first. A PE file on disk has no threads, no
registers, no execution — if the workspace is genuinely useful with that
provider, the abstraction is real. Then get to a second capability set early —
the minidump provider in P2 is the cheap way, since it's a file parser with no
debug loop — because the second provider is what actually validates the
interface. The hypervisor becomes a capability superset, not a foundation.

This matches what you already said you wanted: multiple modular ways to attach.
Detail in [03-Target-Providers.md](../architecture/target-providers.md).

### B4 — Facts and opinions are stored in the same place

The vision's node list mixes `Instruction` (a fact — re-derivable from bytes, same
for everyone) with things that are inherently opinions: a function's name, its
signature, whether a region is "malicious". IDA and Ghidra both blur this line,
and it's the root cause of their worst workflow problems — you can't diff two
analysts' work, you can't review it, you can't selectively revert.

For an AI product this isn't a nice-to-have. If the model renames 400 functions,
you need to answer "show me only what the AI changed" and "revert all of it"
without losing your own work.

**Direction:** two layers. **Facts** are a derived cache, keyed by input content
hash, discardable and recomputable. **Interpretation** is an append-only log of
typed edits, each with an author (human / rule / model + model ID), a timestamp,
and optional evidence links. Undo, diff, review, attribution, and multi-analyst
merge all fall out of this for free.

### B5 — "RetDec is one stage of the pipeline" undersells a real decision

Decompiler choice determines your IR, which determines what semantic analysis you
can write. Don't pick it casually, and don't hardcode it.

Practical shape (verify current licensing and maintenance status before
committing to any of these):

- **Ghidra's decompiler** — already a standalone C++ process that Ghidra drives
  over stdio, permissively licensed, best-in-class among non-commercial options,
  and gives you **p-code** as a language-agnostic IR. This fits the
  out-of-process model in [03-Target-Providers.md](../architecture/target-providers.md)
  exactly. Strong default.
- **RetDec** — LLVM-based, permissive, but check its maintenance state.
- **Hex-Rays / Binary Ninja** — commercial; support as optional integrations for
  analysts who own licenses. Do not depend on them.

**Direction:** `IDecompilerService` with an interface, at least two
implementations before you commit, and p-code (or equivalent) as the IR your
**semantic passes** consume — never scrape the decompiler's C output for
analysis.

Note the asymmetry, because it's easy to get backwards: p-code is the IR for
*your code*, C is the input for *the model*. Ranked for AI grounding,
**C ≫ refined p-code > assembly ≫ raw p-code** — raw p-code is verbose and
low-level enough that it's worse than disassembly as a prompt. Detail in
[07-Roadmap.md](../planning/roadmap.md) P2.

### B6 — `ctx.memory`, `ctx.graph`, `ctx.ai` implies a bespoke scripting runtime

Don't build one. But separate two things the phrase "scripting API" bundles
together:

- **The capability surface** — that `readMemory`, `disassemble`, `xrefsTo`,
  `rename` are callable programmatically at all. **Required**, and you're
  building it anyway: it's the DTP protocol plus the AI tool set. There is no
  separate scripting-API project.
- **The binding** — how user code reaches that surface.

Being an IDE gives you the *editing* experience for free, not the API. Without a
programmatic surface, "users can write their own code" means shelling out to a
separate tool and losing the current target, the current focus, and the
interpretation layer — which is the bad part of today's workflow, not a solution
to it.

**Direction: ship a Python client over the protocol. Do not build a `delver.*`
TypeScript extension-host API.**

1. **Python is the lingua franca of RE scripting** — IDAPython, Ghidra
   scripting, Binary Ninja's API. TypeScript is not. This decides it.
2. The extension-host files (`extHost.api.impl.ts`, `extHost.protocol.ts`,
   `extensionHost.contribution.ts`) are the highest-conflict files in the fork.
   Paying that recurring tax for the least differentiated feature is a bad
   trade.
3. The workflow already exists with **zero fork changes**: integrated terminal,
   the Python extension, notebooks with a Python kernel, debugging.

What you give up: UI-contributing plugins (mitigate by exposing a few UI ops —
`reportFinding`, `setFocus`, `annotate` — over the protocol), extension
lifecycle (an in-IDE script runner is a small contrib, not an API layer), and
marketplace distribution (IDA and Ghidra both live fine with copied script
files). None of these are P1–P5 problems. Revisit only when someone genuinely
wants to ship a UI-contributing plugin.

Detail in [04-IDE-Architecture.md](../architecture/ide-architecture.md) §5.

---

## What's missing

### G1 — Diff is the highest-value verb and isn't mentioned

"Loaded image in memory vs. the same module on disk" is a one-command operation
that falls straight out of the data model and finds inline hooks, IAT patches,
and unpacked sections immediately. It is arguably the single most useful thing a
memory-aware RE tool does, and VS Code hands you a mature diff editor to render
it. Snapshot-vs-snapshot diff is the same machinery.

Make diff a first-class verb over any two `(Location, Moment)` pairs. It lands
in P4 with the first live provider — pull it forward if packed samples dominate
the team's work.

### G2 — Memory region lifecycle is the actual malware detector

The sequence *allocated → written → protection changed to executable → executed*
is the highest-signal behavioral indicator in Windows malware, and it is a pure
query over the data model if you record region lifecycle events with Moments.
The vision's Timeline view should be built around this specifically, not as a
generic event log.

### G3 — Annotations must survive rebasing

If an analyst names 200 functions in a dump, then re-dumps the process after a
reboot, ASLR moves everything and all 200 names are lost. Absolute virtual
addresses are not stable identities.

**Anchor annotations to `(module content hash, RVA)`**, not to VAs. For
dynamically allocated code with no on-disk backing, anchor to
`(allocation identity, offset)` plus a content fingerprint so re-attachment can be
attempted and reported as confident/uncertain. This is a data-model decision, so
it must land in P1 or it never lands.

### G4 — The knowledge base is the moat, and it's in "long-term vision"

The differentiator isn't "the AI explains this function" — every tool will have
that within a year. It's that investigation *N* makes investigation *N+1*
cheaper: a concluded investigation compiles into a reusable detection recipe
(a YARA rule plus a structural graph query plus the evidence that justified it),
and future targets are checked against the accumulated library automatically.

That's the thing competitors can't copy, because it's your users' accumulated
work. It doesn't need to *ship* early, but the `Finding` and `Recipe` schemas
need to exist in P1 so the data is being captured from day one. Retroactively
mining chat logs for findings does not work.

### G5 — Regression testing for the analysis pipeline

RE tooling rots silently — a disassembler change quietly drops 3% of functions
and nobody notices for months. Keep a golden corpus of samples with expected
facts (function count, entry points, import lists, known-tricky constructs) and
snapshot-test the pipeline. This is also the substrate for AI evals
(see [05-AI-Analyst.md](../architecture/ai-analyst.md)).

### G6 — Fork hygiene and licensing

Two practical items that bite forks:

- Upstream moves fast. Without a discipline of "new files only, minimal touch
  points, logged in [PATCH-SURFACE.md](../development/patch-surface.md)", merges become the
  dominant cost within a year.
- The Microsoft extension marketplace's terms do not permit non-VS Code clients.
  Point the fork at Open VSX or a self-hosted gallery, and strip Microsoft
  branding per the MIT terms.

---

## Direction in one page

1. `Location` + `Moment` are the two universal primitives. Nothing reads data
   without both.
2. Facts are a recomputable cache. Interpretation is an attributed, append-only
   log. Never mix them.
3. Attach is a capability-negotiated provider interface. Build the file provider
   and the live-process provider before anything hypervisor-shaped.
4. Heavy work — parsing, disassembly, decompilation — runs out of process, in a
   sandbox, behind a protocol. The renderer never touches sample bytes with a
   parser.
5. One API surface (`delver.*`) serves UI, scripts, and AI tools.
6. The AI writes proposals with evidence, not facts. A human or a rule promotes
   them.
7. Reuse VS Code aggressively: editors, tabs, quick access, markers, notebooks,
   diff, peek, chat tools, MCP. Every one of those you don't write is a month.
