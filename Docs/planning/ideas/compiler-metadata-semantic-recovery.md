# Compiler metadata as semantic recovery

**Status:** open; the read-only spike below has been run — 2026-08-31 —
and its result is a recommendation to schedule, not to build yet

## What

Build a provider-independent semantic-recovery pipeline whose first extractor is
C++ RTTI and vtable recovery. For Delver's current PE/x86/x64 scope, begin with
the MSVC ABI: recover type descriptors, complete-object locators, class hierarchy
and base-class descriptors, vftables and their function slots. Add the Itanium
C++ ABI when ELF and Mach-O arrive rather than pretending the layouts are one
format.

The useful result is not an "RTTI view." It is a class model that every surface
can query:

- classes and stable type identities, decorated and demangled names, and
  confidence-bearing provenance;
- inheritance edges, base offsets, virtual inheritance flags, and vtable groups;
- vtable slots mapped to function RVAs and candidate virtual dispatch targets;
- constructor/destructor and `this`-type hints when supported by additional
  instruction evidence;
- bounded class summaries for UI, MCP, graph queries, and on-demand AI context.

Directly decoded descriptors and pointer relationships are recomputable facts.
Heuristic class layout, method role, prototype, or field inferences are
confidence-bearing derived facts or reviewable interpretations; they must never
masquerade as exact RTTI. Persist normalized results in `.delverdb`, while any
backend-native type state remains a disposable accelerator.

## Why it might be good

This is unusually high-leverage context. One valid RTTI chain can replace dozens
of anonymous functions and indirect calls with a named class hierarchy, relate
constructors, destructors and overrides, and bound the targets of virtual calls.
That helps a human and an agent reason about intent rather than repeatedly
reconstructing object relationships from isolated pseudocode.

It also fits Delver's existing model: `Class`/`Type` graph nodes, `inherits` and
`virtualDispatch` edges, image-RVA anchors, fact provenance, and S4 type
refinement. Context should be retrieved per class or function, not dumped into
every model prompt.

## Why it might not be

RTTI is ABI-specific and incomplete. MSVC `/GR-`, stripped or obfuscated
binaries, non-polymorphic classes, custom runtimes, and link-time folding may
leave little or misleading metadata. RTTI also describes polymorphic type
relationships, not full field layouts or business meaning. A parser that scans
for plausible pointers without validating section bounds, relocations, descriptor
relationships, and executable vtable slots will create confident false classes.

The extractor therefore needs strict structural validation, explicit
`exact | partial | heuristic` completeness, negative evidence, parser fuzzing,
and a no-RTTI fallback that is visibly less confident.

## Adjacent enrichers, in recommended order

1. **Demangling plus symbol/signature ingestion.** PDB/DWARF when present,
   exports/imports, compiler-generated names, and library signatures provide the
   cheapest trustworthy names and prototypes.
2. **Exception and unwind metadata.** PE `RUNTIME_FUNCTION`/`UNWIND_INFO` and C++
   exception tables improve function boundaries, stack unwinding, catch types,
   cleanup regions, and constructor/destructor identification.
3. **RTTI plus validated vtable recovery.** Use exact descriptors first, then
   extend class recovery with constructor vptr writes, thunk recognition, and
   call-site evidence when RTTI is absent.
4. **Prototype and calling-convention inference.** Combine call sites, register
   and stack use, imports, decompiler variables, and recovered `this` pointers;
   accepted types feed back into every decompiler backend.
5. **Global and structure-field inference.** Cluster repeated base+offset access,
   allocation sizes, initializers, and copy patterns into reviewable layouts.
6. **Compiler/runtime-specific metadata packs.** Go function/module metadata,
   Rust vtables and panic/runtime artifacts, Objective-C metadata, and .NET
   metadata should be independent capability-gated extractors, not branches in
   one universal RTTI parser.
7. **Behavior summaries.** Imports, strings, constants, CFG/call paths, API
   semantics, and later dynamic observations produce concise per-function and
   per-class summaries with evidence links.

## Spike result — 2026-08-31

A read-only spike over 69 System32 PE32+ images plus `Auto-updater.exe`, scanning
`.rdata` and `.data` for MSVC complete-object locators. It answers the two
questions that decide whether this is worth scheduling: is the metadata *there*,
and can it be validated rather than guessed at.

**It is there, in more than half of what was looked at.** 38 of 69 images carry
validated RTTI, naming 4,130 distinct classes. The distribution is very uneven —
`cdp.dll` alone accounts for 2,228 — and the images with none are the ones you
would expect, C code like `ntdll.dll`, `appinfo.dll` and `cdd.dll`, which is the
honest negative rather than a parser failure.

**The validation is the whole feature.** Candidates surviving each check, summed
across those images:

| check | surviving |
| --- | --- |
| `signature == 1` | 211,686 |
| `pSelf` equals the locator's own RVA | 4,824 |
| type-descriptor pointer maps into a section | 4,824 |
| descriptor name begins `.?A` | 4,771 |

The self-reference check alone removes **97.7%** of candidates. A scanner that
skipped it — that took four bytes reading as `1` followed by plausible-looking
pointers — would report forty-four times more classes than exist, every one of
them confident and wrong. That is precisely the failure this document's own "why
it might not be" section warns about, now with a number on it. It is also
cheap: the check is a single comparison per candidate and needs no relocation
processing, because on x64 the field is already an RVA.

**What it recovers is the kind of thing that helps.** `Auto-updater.exe` yields
eight classes including `basic_ifstream`, `basic_filebuf`, and a lambda whose
decorated name carries the enclosing function `downloadFile` — three facts about
a 764 KB stripped binary that no amount of reading pseudocode hands you as
directly.

**What the spike did not cover.** Only the locator → type-descriptor edge. Class
hierarchy descriptors, base-class arrays, vftable slot mapping and virtual
inheritance were not touched, and neither was a `/GR-` or deliberately malformed
corpus. The zero-false-exact-match criterion below is therefore *not* yet met —
what is established is that the entry point into the graph validates strongly and
that the data exists at a useful rate.

**Recommendation: schedule, do not start.** It stays a P5 item. The spike says
the leverage is real and the false-positive risk is controllable, which is what
was unknown; it does not say the remaining structures are, and this is not P5.

## What would settle it

Implement a read-only MSVC x64 spike against a small redistributable corpus with
single inheritance, multiple inheritance, virtual inheritance, `/GR-`, stripped
symbols, and malformed near-matches. The spike succeeds if it:

- reconstructs the expected class/inheritance/vftable graph with zero false
  exact matches;
- emits bounded provenance from every recovered entity to descriptor and slot
  RVAs;
- degrades honestly on `/GR-` and malformed inputs;
- lets one MCP call retrieve a class and its virtual methods without exposing
  raw parser internals; and
- measurably improves a fixed human/agent reverse-engineering task over strings,
  xrefs, and pseudocode alone.

Primary references: [Microsoft RTTI overview](https://learn.microsoft.com/en-us/cpp/cpp/run-time-type-information?view=msvc-170),
[MSVC `/GR` option](https://learn.microsoft.com/en-us/cpp/build/reference/gr-enable-run-time-type-information?view=msvc-170),
and the [Itanium C++ ABI RTTI and vtable layout](https://itanium-cxx-abi.github.io/cxx-abi/abi.html).
