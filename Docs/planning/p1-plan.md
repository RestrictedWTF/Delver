# P1 Implementation Plan

**The prototype.** A static RE tool the team uses instead of reaching for
something else, and the foundation the decompiler queries in P2.

P0 is complete and archived at
[`history/plans/p0-plan.md`](../history/plans/p0-plan.md) — read its outcome
banner for what diverged and what was carried forward.

Sizes are relative (S / M / L). See [roadmap.md](roadmap.md) for how P1 fits.

---

## What P1 inherits from P0

Assumed working before Stage D begins:

- `delver-core`, `delver-protocol`, `delver-rpc` (stdio), `provider-file`,
  `delverctl`
- Protocol codegen: Rust → `schema/protocol.schema.json` →
  `protocol.generated.ts`
- `src/vs/platform/delver/` types + `providerProcess.ts` + `delverBinaries.ts`
- `build/gulpfile.delver.ts` staging binaries
- `IDelverTargetService` and a sections view proving the pipe end to end

If any of that is still stubbed, finish it before starting here. P1 assumes the
boundary works.

## Shape of the plan

Four stages. Same philosophy as P0 — the engine is built and tested headless
before any UI depends on it.

```
Stage D   Analysis engine, driven by delverctl          (no IDE involved)
Stage E   The listing editor                            (the big UI piece)
Stage F   Interpretation and persistence                (work starts accumulating)
Stage G   Supporting views                              (breadth)
```

Stage D is the long pole and the one that must not be rushed — everything in
E, F, and G reads from it, and P2's decompiler responder is built directly on
its fact store.

---

## Decisions to settle before writing code

Six calls, following the pattern from
[p0-plan.md](../history/plans/p0-plan.md). Recommendations given; record the
ones that stick in [`../history/adr/`](../history/adr/).

### E1 — Analysis connects to the provider directly, over a named pipe

The analysis server needs a lot of bytes. Three topologies were available:

| Option | Verdict |
| --- | --- |
| Workbench relays bytes between provider and analysis | Bulk target data through the UI process. No. |
| Analysis links `delver-format` and opens the file itself | Works for P1, but bypasses the provider abstraction entirely — and then nothing exercises it until P4, which is exactly the "validated late" failure we ordered the roadmap to avoid. |
| **Provider accepts multiple clients; workbench and analysis both connect** | **Chosen.** |

**Decision:** `provider-file` gains a `--listen <endpoint>` mode alongside stdio,
and accepts concurrent clients for read-only methods. The workbench spawns it,
then hands the endpoint to the analysis server.

This forces the **named-pipe transport in `delver-rpc`** — deferred from P0 and
already noted as such in [ledger.md](ledger.md). It lands here, where there's a
reason for it.

State-changing methods stay single-client. The file provider has none, so the
policy costs nothing now and is already correct when P4 introduces `halt`.

### E2 — Superseded: portable projects persist useful facts

P1 initially kept the fact store in RAM and persisted only the interpretation
log and project metadata. Decompilation made that boundary too narrow: reopening
should not discard expensive functions, strings, mappings, or pseudocode.

ADR [0005](../history/adr/0005-portable-project-database.md) supersedes this
planning decision. The portable SQLite `.delverdb` persists useful normalized
facts and decompiler results alongside the append-only interpretation log. It
never embeds sample bytes. Backend-native databases remain separate local
accelerators; see
[session-persistence.md](../architecture/session-persistence.md).

### E3 — `delver-store` is Rust, owned by the analysis server

The listing must merge authored names with disassembled facts **per row, at
render time**. Doing that join in the renderer is precisely the thing that
destroys a 60 fps scroll.

So the edit log lives in Rust next to the facts. The workbench drives it over
the protocol — open, save, apply edit, query — and never holds the log itself.

### E4 — Build a full instruction index on open

Variable-length instructions mean **row ordinal ↔ address is not arithmetic**.
A virtualized table needs an exact total row count and O(log n) mapping in both
directions.

**Decision:** on open, linearly index the module in the background with progress
reporting. Exact row counts, exact scrollbar, correct "go to row N".

The alternative — page-based approximation — is cheaper but the scrollbar lies
and address-to-row is wrong near the ends. IDA and Ghidra both index fully;
follow them.

This is the single biggest compute cost in P1. Budget for it, report progress,
and render placeholder rows while it runs
([data-model.md](../architecture/data-model.md) §8).

### E5 — Listing rows are JSON objects, not packed columns

At ~100 rows per fetch that's roughly 15 KB of JSON. Fine.

The 4,000-row figure in the perf budget is the *cache*, filled by many small
fetches — not one payload. Don't pre-optimize. If profiling later shows JSON
parse on the scroll path, the escape hatch is a binary frame with packed
parallel arrays, and the row shape survives that change.

### E6 — Function detection seeds, in priority order

1. **Exception directory** (`RUNTIME_FUNCTION` / `UNWIND_INFO`). On x64 PE this
   is the highest-value seed source in existence and it's nearly free — the
   compiler already told you where the functions are.
2. Entry point and exports.
3. Recursive descent from call targets.
4. Linear sweep over remaining gaps, **marked lower confidence**.

Record confidence per function. [design/principles.md](../design/principles.md)
§1 requires a guessed boundary to render differently from a confirmed one, so
the data has to carry it from the start.

---

## Protocol v1 additions

Grouped by owner. Provider methods stay as they are; everything new is on the
analysis server.

| Method | Purpose |
| --- | --- |
| `analysis/openImage` | Begin indexing; returns `imageId` |
| `analysis/imageProgress` *(notification)* | Indexing progress and completion |
| `analysis/getImageInfo` | Extends P0: imports, exports, relocs, exception dir, TLS |
| `analysis/listingWindow` | Rows `[start, start+count)` for an image |
| `analysis/rowForAddress` · `addressForRow` | The E4 index, both directions |
| `analysis/functions` | Function list with entry, bounds, confidence |
| `analysis/xrefsTo` · `xrefsFrom` | Both directions |
| `analysis/strings` | Located strings with encoding |
| `store/open` · `store/save` | `.delverdb` lifecycle |
| `store/applyEdit` · `store/queryEdits` | The interpretation log |

Bump `protocolVersion`. A P0 provider binary must fail cleanly against a P1
workbench, not half-work.

---

## Tasks

### Stage D — analysis engine, headless

**D1 · Named-pipe transport in `delver-rpc`** — M
`--listen <endpoint>` server mode, multi-client for read-only methods. Windows
named pipe with a per-session random name and a user-restricted ACL; Unix
socket in a mode-0700 directory on POSIX.
*Done when:* two `delverctl` instances read from one provider concurrently.

**D2 · `delver-format` — full PE** — M
Imports, exports, relocations, exception directory, TLS, resources, debug
directory. Moves the P0 parsing out of `provider-file` into the shared crate.
*Done when:* `delverctl info` reports imports and exports; the exception
directory is exposed as function seeds.

**D3 · `delver-disasm`** — M
`iced-x86` behind an interface, windowed decode, never whole-module in one pass.
*Done when:* a decode of an arbitrary range returns correct instruction text
and lengths, verified against a known-good listing in the corpus.

**D4 · Golden corpus + runner** — M
`delver/corpus/` with benign binaries and expected-fact snapshots. `delverctl`
subcommand producing the snapshot; `npm run delver:corpus` diffing it.
**Build this before D5, not after** — it's the regression net for every analysis
change that follows.
*Done when:* it runs in CI and fails on a deliberate regression.

**D5 · `delver-analysis` — functions, index, xrefs, strings** — L
Function detection per E6. The full instruction index per E4 with progress
reporting. Code and data xrefs in sorted both-direction tables. String
extraction (ASCII + UTF-16).
*Done when:* function count and entry points match the corpus expectations for
every sample.

**D6 · `server-analysis` process** — M
Owns the fact store, connects to a provider per E1, serves the v1 methods.
*Done when:* `delverctl` drives a full pipeline — open image, wait for
indexing, fetch a listing window — with the provider and analysis as separate
processes.

### Stage E — the listing

**E1t · Focus bus** — M
`IDelverFocusService` per [ide-architecture.md](../architecture/ide-architecture.md) §3:
`origin` on every change, history with proximity coalescing, back/forward.
*Done when:* two views can drive each other without an update loop.

**E2t · Listing editor** — L
`DelverListingInput` + `EditorPane` + `WorkbenchTable`. Read
`src/vs/workbench/contrib/debug/browser/disassemblyView.ts` first.
Paged, cancellable data source; placeholder rows while a page is in flight;
columns for gutter, address, bytes, mnemonic, operands, comment, xref margin.
*Done when:* a 50 MB binary scrolls at 60 fps with no blocking fetch.

**E3t · Quick access + address history** — S
Go to address, go to symbol, go to string. Alt+Left / Alt+Right on the focus
history; Mouse4 / Mouse5 use the same stack while the listing is active.
*Done when:* an address typed into quick access lands on the right row.

**E4t · Per-view pin** — S
Title-bar toggle on every synchronized view.
*Done when:* two listings can be compared with one frozen.

### Stage F — interpretation and persistence

**F1 · `delver-store`** — M
SQLite (WAL), append-only `edit_log`, materialized current-state view, project
metadata. Opens with no target attached.
*Done when:* an edit log survives close/reopen and the materialized view
matches a replay of the log.

**F2 · Anchors** — M
`(contentHash, rva)` resolution with `exact` / `fuzzy` / `orphaned` reporting
([data-model.md](../architecture/data-model.md) §4). Image normalization —
relocations undone, IAT zeroed — reused by the P4 diff.
*Done when:* annotations reattach correctly to a rebased copy of the same
module and report their match quality.

**F3 · Rename, comment, tag** — M
Inline in the listing, single keystroke to start, `Esc` to abandon. Attributed
and undoable. Names merge into listing rows server-side per E3.
*Done when:* 30 renames survive a close/reopen and "revert this author" works.

**Implemented UI decision (2026-08-08):** names and comments are owned by the
instruction row, never synthetic analysis rows. A label sits above the
instruction; its comment follows the operands on the instruction line. Both are
bounded, and newlines imported from a log are folded for display without changing
the stored value. This keeps analysis row ordinals exact and makes height depend
only on the optional label line.

Tags follow the comment as bounded `#tag` tokens. Undo and revert-by-author are
compensating accepted edits carrying the sequence IDs they supersede; the JSONL
history is never rewritten. Import into a non-empty log resequences the incoming
records and their compensation references before appending.

### Stage G — supporting views

**G1 · Strings view** — S · filter, sort, xref-to
**G2 · Imports / exports / sections trees** — S
**G3 · Outline = function list** — S · with confidence indication per E6
**G4 · Hex view** — M · unreadable `??` distinct from zero bytes
**G5 · Findings → `IMarkerService`** — S · scaffolding only; producers come in P3

---

## Definition of done

The roadmap's P1 exit, stated concretely:

> An analyst opens an unknown PE, navigates it by symbol and address, reads the
> disassembly, names 30 functions, writes comments, closes it, reopens it
> tomorrow, and everything is there.

Plus:

- A 50 MB binary scrolls at 60 fps.
- The golden corpus runs in CI and has caught at least one real regression.
- Analysis and provider are separate processes; killing either is survivable.
- Someone on the team chooses Delver over their usual tool for a first-pass
  static look, at least once.

## Explicitly not in P1

Decompilation · p-code · types and structs · CFG or any graph · signature
matching · ELF and Mach-O · demangling beyond MSVC basics · non-x86 · YARA
search · any AI · live targets · sandboxing · persistent fact cache.

## Can slide out of P1

- **Hex view (G4)** — nothing in P2 needs it, and it pairs better with live
  memory in P4.
- **Resources and debug-directory parsing (D2)** — entry points and code first.
- **Findings scaffolding (G5)** — no producers until P3.

---

## First tasks of P2

So the handoff is obvious rather than a fresh planning session:

1. **Ghidra headless scaffold** — a script emitting
   `{C text, address↔line map, variables}` as JSON, behind `IDecompilerService`.
   Days, and it answers whether AI-on-decompilation works on your samples
   before P2b is paid for.
2. **Pseudocode editor** — `delver-pseudo:` scheme, `delver-c` language,
   line ↔ address map driving the focus bus.
3. **Minidump provider** — the cheap second provider that keeps
   `ITargetProvider` honest while the debugger stays deferred to P4.

Full detail in [roadmap.md](roadmap.md) P2.
