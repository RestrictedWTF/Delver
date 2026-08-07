# Stage D — Analysis Engine

Task-level plan for the remaining Stage D work in P1: **D3–D6**. Sits under
[p1-plan.md](p1-plan.md), which holds the phase-level view.

D1 (named-pipe transport) and D2 (`delver-format`) are complete — see
[status.md](status.md).

Everything here is built and tested **headless via `delverctl`**, with no IDE
involvement, exactly as Stage B was. Stage E depends on all of it.

---

## Decisions to settle before writing code

Four calls, following the pattern from the P0 and P1 plans.

### F1 — The decoder returns text *and* structure, not text alone

A formatted string is what the listing renders; it is useless for xref
extraction. Re-parsing `"call qword ptr [rip+0x1234]"` to recover a target
would be a parser on top of a parser.

**Decision:** one decode pass yields both — a formatted mnemonic/operand string
for display, plus the structured facts D5 needs:

- flow control kind (call / jump / conditional / return / interrupt)
- resolved branch target when it is absolute or RIP-relative
- memory operand target when RIP-relative
- immediate values that fall inside the image

`delver-analysis` consumes the structure; only the listing touches the text.

**Amended 2026-08-07.** The rule this encodes is *structure is never recovered
by parsing text* — not *text is always produced*. Whole-image analysis decodes
millions of instructions and displays none of them, and formatting each one was
the single largest cost in the pass. `decode_facts_at` returns the structure
alone; `decode_count` still returns both in one pass for callers that render.
Both derive the structure from the same function, so they cannot disagree about
where a branch goes.

### F2 — Windowed decode never starts mid-instruction on its own authority

x86 is variable-length and not self-synchronising. Decoding from an arbitrary
RVA produces plausible-looking garbage that silently differs from the real
instruction stream.

**Decision:** `decode_window` takes an **anchor** the caller vouches for — a
function seed, a previously decoded instruction boundary, or a section start —
and decodes forward from it. A request for an unanchored address returns the
nearest known-good anchor plus the offset, so the caller can decide rather than
being handed a guess.

This is the same principle as invariant 7: report what you do not know rather
than fabricating a plausible answer.

### F3 — Bitness comes from the image, never a parameter default

`delver-format` already reports `arch`. The decoder takes bitness explicitly at
construction and has no default. A 32-bit image decoded as 64-bit yields
confident nonsense, which is the worst failure mode available.

### F4 — Corpus samples are benign and redistributable

The golden corpus is committed to a public repo. It must contain **no malware
and nothing whose license forbids redistribution** — so no Windows system DLLs,
despite their being convenient test material.

**Decision:** the corpus holds small binaries built from source we control,
committed with their source, plus expected-fact JSON snapshots. Anything
non-redistributable is referenced by path for local-only runs and skipped in CI.

See [security-model.md](../architecture/security-model.md) §5.

---

## Tasks

### D3 · `delver-disasm` — M

`iced-x86` behind a Delver-owned interface. Windowed decode per F2, structured
output per F1, explicit bitness per F3.

*Done when:* decoding a known byte sequence yields correct text, lengths, and
branch targets, and decoding across a window boundary agrees with decoding the
whole range in one pass.

### D4 · Golden corpus + runner — M

`delver/corpus/` with committed sources, built binaries, and expected-fact
snapshots. A `delverctl` subcommand emits the snapshot; `npm run delver:corpus`
diffs it.

**Build this before D5.** It is the regression net for everything that follows,
and after the fact it never gets built.

*Done when:* it runs in CI and fails on a deliberately introduced regression.

### D5 · `delver-analysis` — L

Function detection seeded from D2 (exception directory first, then entry point,
exports, TLS callbacks), extended by recursive descent from call targets and a
linear sweep over the remaining gaps at lower confidence.

Plus the full instruction index (P1 decision E4), code and data xrefs in sorted
both-direction tables, and string extraction.

*Done when:* function counts and entry points match corpus expectations for
every sample, and `rowForAddress`/`addressForRow` round-trip exactly.

### D6 · `server-analysis` — M

The process that owns the fact store, connects to a provider per P1 decision
E1, and serves the v1 analysis methods.

*Done when:* `delverctl` drives the full pipeline — open image, await indexing,
fetch a listing window — with provider and analysis as separate processes.

---

## Definition of done for Stage D

`delverctl` can open a PE through a provider, have the analysis server index
it, and print a correct disassembly window for an arbitrary function — with no
IDE running. Stage E then has something real to render.
