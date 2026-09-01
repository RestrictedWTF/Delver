# Compiler metadata as semantic recovery

**Status:** partly started — 2026-08-31. The bounded vtable slice below is
being built ([ADR 0019](../../history/adr/0019-vtable-slice-bounded-by-recovered-functions.md));
everything else here remains a P5 item, unmeasured and not started

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

### Spike 2: the vftable edge, and where the naive walk breaks

The first spike stopped at the locator → type-descriptor edge, which is the
entry into the graph but not the part that yields anything an analyst reads. The
second walks one edge further, over the same 69 images plus `Auto-updater.exe`:
a locator is pointed at from `[vftable - 8]`, so the qwords after that referrer
are the class's virtual method slots.

| | |
| --- | --- |
| validated locators | 4,779 |
| locators with a vftable above them | **4,779 (100.0%)** |
| executable slots recovered | 39,319 |
| walks ending at a non-executable pointer | 4,678 (97.9%) |

**The existence edge validates completely.** Not one validated locator lacked a
referrer, which is stronger than the 97.7% filter of spike 1 and means the
vftable is not a heuristic step — it is structural, and the locator check already
did the discriminating.

The two spikes' totals reconcile: spike 1 ran over the 69 System32 images and
ended at 4,771 named locators; spike 2 added `Auto-updater.exe`, whose 8 classes
make 4,779. The corpora differ by one image, not the filters by one rule.

**What the shipped implementation measures.** The Rust scanner reproduces the
spike exactly on every image but `cdp.dll`, where it reported 2,416
`(locator, vftable)` pairs against the spike's 2,369. That 47-pair gap was run
down rather than left standing, and **the scanner is right**: the spike capped
the type-descriptor name window at 512 bytes, and all 47 rejected locators name
WRL `DelegateInvokeHelper` template instantiations whose decorated names are
538–999 bytes. The longest name the spike accepts in that image is 491 bytes — a
cut exactly at its own window. `cdp.dll` is the only image in the corpus with
mangled names past 512 bytes, which is why one image disagreed and sixty-nine
did not.

Each of the 47 passes the `pSelf` discriminator, names a `.?A` descriptor, and
has a referrer whose following qwords land in `.text`. Two of them are the same
class at `base_offset` 0 and 8 — the multiple-inheritance case `base_offset`
exists to record.

The consequence for the numbers above: the spike's totals are a floor, not a
count. `MAX_DECORATED_NAME` is 4096 in the implementation, against a longest
observed name of 999.

**The termination rule does not validate.** Walking "until a pointer that is not
into executable memory" is wrong at the end of a pointer region, and the slot
histogram shows exactly where:

| slots | vtables |
| --- | --- |
| 1–8 | 3,834 |
| 9–32 | 848 |
| 33–64 | 77 |
| **>64** | **20** |

All twenty runaways are the same class — `std::bad_array_new_length`, which has
two virtual methods and is reported with up to **3,166 slots**. It is the *last*
RTTI vtable in `.rdata` in those images, so the walk leaves the vtable and
continues through whatever array of function pointers follows. A boundary test
confirmed the complementary fact: **zero** walks swallow another
locator-preceded vtable, so the overrun is always into non-RTTI pointer data,
which is why it survives the obvious check.

**The fix is a terminator Delver has and a standalone RTTI parser does not.** A
slot is a slot only if it points at a *recovered function entry*, not merely into
executable memory. Delver's function set — now including chained-fragment
attribution — is exactly that oracle. This is worth stating as a design
constraint rather than an implementation detail: the vtable slice depends on
function recovery having run, and is not a parser that can stand alone.

**Recommendation: start the vtable slice, schedule the rest.** The spikes say
the leverage is real and the false-positive risk is controllable on the two edges
they measured — locator at 97.7% filtered, vftable at 100% — which is what was
unknown. They say nothing about the hierarchy descriptors, base-class arrays or
virtual inheritance, so those stay P5 on the same terms as before.

What is lifted out is the bounded *vtable* slice: MSVC x64 locators, decorated
class names, and method slots, with no hierarchy and no class model. It is gated
on the slot terminator above, and the terminator that works is the one a
standalone parser cannot have — a slot is admitted only when its target is a
recovered function entry, which makes the slice dependent on function recovery
having run. That dependency, and the truncation it trades the runaway tables
for, are recorded in
[ADR 0019](../../history/adr/0019-vtable-slice-bounded-by-recovered-functions.md).

## Raised, not decided: vtable slots as a function-seed source

Building the vtable slice surfaced a question it cannot answer itself. The slot
walk admits only addresses already recovered as functions, and measurement
([ADR 0019](../../history/adr/0019-vtable-slice-bounded-by-recovered-functions.md))
shows 460 of 4,832 tables truncate under that rule, the worst reporting one slot
of fifty-five. The stopping address in those cases is a real virtual method that
is a leaf function with no unwind data: `.pdata` never named it, and no decoded
path reached it, so neither the exception directory nor the sweep produced a
seed.

A vtable slot is itself strong evidence of a function start — stronger than a
linear sweep's guess, since the compiler emitted a dispatch to it. Feeding
validated slots back as a `SeedSource` and re-deriving would recover exactly the
functions the walk is missing, and the second pass would then admit the slots
that stopped it.

What makes this a decision rather than an obvious win:

- It is **circular by construction** — slots depend on functions, and functions
  would depend on slots. It terminates (one extra pass, seeded from the first),
  but the fixpoint has to be defined rather than assumed, and a re-derivation
  ([ADR 0015](../../history/adr/0015-authored-corrections-re-derive-facts.md))
  must not oscillate.
- It **admits attacker-influenced addresses into the function set**. Today a
  malformed vtable produces a short table; afterwards it would produce function
  starts, which is a larger blast radius and needs its own confidence tier
  rather than the authoritative one the exception directory gets.
- It changes what `FunctionSource` means for a whole class of functions, which
  0017's reconciliation reads. A new source should show up there as a named
  category, not silently widen `delverOnly`.

The measurement to settle it: seed from validated slots, re-derive, and count
how many of the 460 truncated tables lengthen against how many new function
starts land somewhere no backend agrees is a function.

### The measurement was run

Two passes over the same 70 images: recover, take every
`NotAFunction{rejected_rva}` address, push each as a function seed, re-derive,
re-walk. Pass 1 reproduces ADR 0019 exactly (4,832 tables, 30,839 slots, 30
zero-slot, 13 over 64, worst 619), so the harness measures the same thing.

**The mechanism is confirmed at the addresses that motivated it.** All 30
zero-slot tables disappear. `cdp.dll`'s `.?AV?$Activity@VICDPActivity@@$$V@cdp@@`
goes **1 → 55** — the exact interface this document predicted — its siblings go
1 → 59, and six `amf-mft-mjpeg-decoder64.dll` interfaces go 1 → 55/56/58.

**The false-positive shape does not appear.** Of 4,455 new function starts:
zero fall strictly inside a pass-1 function's extent, zero inside a chained
fragment, and zero land mid-instruction in pass 1's decoded stream. 96% are in
bytes function recovery never reached at all — the "leaf function, no `.pdata`,
nothing branches to it" profile ADR 0019 diagnosed.

**And the headline is still wrong.** 4,560 tables lengthen, but 4,256 of those
gain exactly one slot, which seeding the address that stopped the walk makes
inevitable — it is arithmetic, not evidence. The real result is **304 tables
materially recovered, +3,142 slots**.

Three things the measurement establishes *against* the change, and they are why
this stays open rather than becoming obvious:

- **ADR 0019's own failure mode returns.** 24 of the grown tables are
  `std::bad_array_new_length` — the two-method class — and they gain **737
  slots** between them (`browserbroker.dll` 82 → 306, `CloudExperienceHostRedirection.dll`
  47 → 287). New starts let the walk run further into the non-RTTI function-pointer
  array that follows the last table in `.rdata`. Tables over 64 slots go 13 → 16.
  That is ~10% of the gain, every slot of it a confident wrong virtual method, in
  a class nameable in advance. Seeding does not merely fail to fix the boundary
  problem — it makes it worse.
- **There is no fixpoint at two passes.** Pass 3 finds 409 further starts and
  +996 slots, decaying about an order of magnitude per pass rather than
  converging. "Seed once" is a policy, not a termination property, and it leaves
  roughly a thousand slots unclaimed.
- **The clean-corpus caveat is the whole risk.** These are Microsoft-signed
  system DLLs. The measurement says nothing about an adversarial vtable, which is
  exactly where "attacker-influenced addresses enter the function set" lives. The
  containment test is also inapplicable to the 46% of pass-1 functions that have
  no `end_rva`; the mid-instruction check covers part of that gap and is the
  stronger of the two, but neither is a cross-backend check. Only 0017's
  reconciliation would say these starts are *real* rather than merely
  non-contradictory.

The spike also used `SeedSource::Export` as a stand-in carrier, which gives these
seeds authoritative treatment — an optimistic bias. A real implementation needs
its own variant at a lower confidence, which is a protocol and reconciliation
change, not a one-line addition.

**Where that leaves it.** The measurement settles the cost side and splits the
change into two effects that are worth deciding apart. 4,455 new function starts
with no implausible shape is a win for *function recovery* — it improves the
listing, the xref table and the call graph regardless of RTTI. Lengthening the
vtables is what carries the 737-slot regression.

Taking the first without the second is possible, but not by default: the vtable
walk reads the function set, so any seed added to it is admitted automatically
and the tables lengthen whether or not that was wanted. Separating them requires
the admission rule to *exclude* functions derived from vtable seeds — which is
also, not coincidentally, the thing that breaks the circularity this document
opened with. That is a real option and it is the conservative one: better
functions everywhere, vtables unchanged, no new wrong slots.

What it costs is the 304 materially recovered tables, including the 1 → 55
interface — those exist only because the seeded functions are admitted. So the
choice is not "seed or not". It is whether the 304 recovered tables are worth 737
confident wrong slots in a class that can be named in advance, and that trade
does not have to be accepted to take the function-recovery half.

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
