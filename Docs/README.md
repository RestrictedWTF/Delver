# Delver Documentation

Delver is an AI-native reverse engineering and malware analysis workspace built
on the VS Code codebase (fork of `microsoft/vscode`, currently at `1.133.0`).

## Layout

| Folder | Holds | Changes |
| --- | --- | --- |
| [`architecture/`](architecture/) | How the system is built. The standing design. | When a design decision changes |
| [`design/`](design/) | How it looks and behaves. Visual and interaction design. | Per surface |
| [`planning/`](planning/) | Roadmap, current status, feature ledger, unproven ideas | Continuously |
| [`development/`](development/) | How to work on the repo | Rarely |
| [`history/`](history/) | Original vision, the critique that shaped it, and ADRs | Append-only |

Filenames are descriptive rather than numbered — reading order lives here, so a
new doc doesn't force a renumber.

## Reading order

**Start here**

1. [`history/original-vision.md`](history/original-vision.md) — the product
   vision, as originally written
2. [`history/critique-and-direction.md`](history/critique-and-direction.md) —
   what survives contact with implementation, what breaks, what's missing

**Before writing any code**

3. [`architecture/data-model.md`](architecture/data-model.md) — address spaces,
   `Moment`, facts vs. interpretation, anchors, storage. *The expensive-to-change
   part.*
4. [`architecture/target-providers.md`](architecture/target-providers.md) — the
   modular attach layer, capability negotiation, the wire protocol
5. [`architecture/project-structure.md`](architecture/project-structure.md) —
   directory layout, crate boundaries, naming, build wiring
6. [`development/working-with-ai.md`](development/working-with-ai.md) —
   invariants, records, lint enforcement, what not to automate

**Before writing UI**

7. [`architecture/ide-architecture.md`](architecture/ide-architecture.md) —
   where code lives in the fork, what to reuse from VS Code, view design
8. [`design/README.md`](design/README.md) — design principles and surface specs

**Before wiring an LLM**

9. [`architecture/ai-analyst.md`](architecture/ai-analyst.md) — grounding,
   provenance, the proposal layer, tools, notebooks, evals
10. [`architecture/security-model.md`](architecture/security-model.md) — running
    an IDE that opens malware, and prompt injection from samples

**Component specs**

- [`architecture/debugger-provider.md`](architecture/debugger-provider.md) — the
  basic Windows debugger, staged D0–D3

**Planning work**

- [`planning/roadmap.md`](planning/roadmap.md) — phases P0–P7, core and depth
  tracks

## Living records

| Record | Question it answers |
| --- | --- |
| [`planning/status.md`](planning/status.md) | *Where were we?* — overwritten each session |
| [`planning/ledger.md`](planning/ledger.md) | *What exists, what's stubbed, what did we skip and why?* |
| [`history/adr/`](history/adr/) | *Why is it this way?* — append-only, superseded not edited |
| [`development/patch-surface.md`](development/patch-surface.md) | *Which upstream files do we modify?* |

The root [`CLAUDE.md`](../CLAUDE.md) holds the invariants that load every
session. Keep it under ~80 lines.

## The one-paragraph summary

Everything in Delver is addressed by a **`Location`** (which address space, which
address) at a **`Moment`** (which coherency epoch). Data reaches the IDE through
**target providers** that advertise **capabilities**, so a PE file on disk, a live
process, a crash dump, and eventually a hypervisor are all the same kind of thing
with different capability sets. The IDE keeps **facts** (bytes, instructions,
xrefs — reproducible) strictly separate from **interpretation** (names, types,
comments, hypotheses — opinions with an author). The AI is an author in the
interpretation layer with the same capability surface as scripts and the UI, and
every claim it makes carries evidence back to a fact.

## Where the project is heading

Priority is **static reverse engineering with decompilation and AI, first**:

1. **P1** — static core: listing, navigation, xrefs, annotation. The prototype
   the team uses, and the foundation the decompiler queries.
2. **P2** — decompilation and p-code, staged through a throwaway Ghidra-headless
   scaffold before the native decompiler process.
3. **P3** — the AI analyst, grounded in decompiled output.
4. **P4** — runtime: live attach, a basic debugger, memory-vs-disk diffing.

Types, graphs, and the knowledge base are on a depth track (P5–P6). Kernel and
hypervisor are parked at P7 by design.

**If your work turns out to be mostly packed malware**, pull D0 (non-invasive
attach) and the memory-vs-disk diff forward out of P4 — they're small and depend
on nothing in P2 or P3.

## Conventions

- Code sketches are illustrative, not final signatures. They exist to pin down
  the shape of a thing so two people don't build incompatible halves.
- Every doc that proposes a service names the file it should live in.
- Anything parked for later is marked **PARKED** with the reason.
