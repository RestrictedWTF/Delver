# Compiler metadata as semantic recovery

**Status:** open; recommended for a bounded P5 spike before scheduling

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
