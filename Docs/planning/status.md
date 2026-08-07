# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [LEDGER.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-07
**Current phase:** P1 **Stage E complete** — focus bus, analysis session, listing editor, navigation, and per-view pin all done

## In flight

**Stage E** — E1t (focus bus) and the analysis session host are done. The
listing editor (E2t) is next.

### Fixed: "Open File Target" did nothing

The command ran, the provider attached, and the Sections view never populated —
no error anywhere. The cause was **`bigint` crossing the shared-process → renderer
IPC boundary**: the previous commit added `size: bigint` to `IAddressSpace`, and
`IDelverTargetSnapshot` carried that type across IPC. VS Code serializes object
payloads with `JSON.stringify`, which throws on `bigint`, and the throw lands
inside the channel server's promise callback — so no response is sent, `attach()`
never settles, and nothing downstream ever runs.

Worth internalising: **that failure mode is silent.** Not a rejection, not a
timeout — a promise that never settles. Any future hang with no error should
look here first.

The snapshot is now wire-shaped, converted to domain types on the renderer edge
by `platform/delver/common/wire.ts`. ADR 0001 is amended to say the hex-string
rule covers *every* process boundary, not just DTP. `providerProcess.test.ts`
guards it by running the real IPC `serialize` over a live snapshot — the bug
cannot be caught at compile time, so it needs a runtime assertion.

Two smaller things fixed alongside: unknown capabilities from a newer provider
are now dropped rather than failing the whole attach (negotiation should degrade,
not abort), and the debug `console.log` tracing added while diagnosing this has
been removed in favour of `onUnexpectedError`.

Debugging note: `DelverProcessService` runs in the **shared process**, so its
`console.log` never reaches the renderer devtools console. That is why the log
appeared to stop dead after `attach called`.

### Fixed: `DelverRpcClient` was not safe for concurrent calls

Surfaced immediately after the above, as `RPC id mismatch: expected 3, got 2`.
`call()` wrote a request and then read a reply with nothing serializing
overlapping callers, so two in-flight calls each took whichever reply arrived
first. The transport is one ordered stream and a response's frames follow it
immediately (ADR 0001), so replies can *only* be read in request order — a
correlation table is not an option, a queue is. `call()` now chains onto the
previous call and swallows the chain's rejection so one failure cannot poison
everything queued behind it.

This was worse than a mismatch: `StreamReader.resolveNext` holds a **single**
waiter, so concurrent reads also silently lost wakeups and parked forever. That
constraint is now documented on the class.

**This would have bitten E2t hard** — a paging listing editor issues overlapping
requests as a matter of course.

What produced the concurrency was a second bug: `attach()` broadcast the target
change locally *and* the shared process broadcast the same change as an event,
so every listener ran twice. `DelverTargetService` now recognises the echo. The
comparison deliberately ignores target kind (invariant 6); it does not need it,
because `attach` always detaches first and so a real change is always separated
from the previous one by an `undefined`.

"Open File Target" now reveals the Sections view before attaching — an empty
view is better feedback than a command that appears to do nothing while a large
image is analysed. Focus is left alone.

### Fixed: indexing cost — 104s → 3.9s on an 88.5 MB image

Measured on `node.exe` (88.5 MB, 8.85M instructions, 178k functions, 1.87M
xrefs). Output is byte-identical before and after, verified by diffing
`delverctl analyze` against the pre-change binary on notepad, kernel32,
advapi32, ws2_32, and the 32-bit kernel32.

| Change | Time |
| --- | --- |
| Debug build, as it was | 103.8 s |
| Release profile | 16.7 s |
| Structure-only decode + flat address state | 3.5 s |
| Debug build with the new dev profile — **what the IDE runs** | 3.9 s |

Three separate causes, and the first was the biggest:

**The dev profile had no optimization.** `delver/target/debug` is what
`resolveBinary` resolves, so the IDE ran `iced-x86` at `opt-level = 0`. Six times
slower than release, for free. Dependencies now build at `opt-level = 3` even in
dev and the workspace at `opt-level = 1`; the first build after this pays ~2.5
minutes to recompile dependencies once, and incremental rebuilds stay at ~1.6 s.

**Analysis was formatting every instruction it decoded.** `decode_count(…, 1)`
built an `IntelFormatter`, formatted to a `String`, and split it into two more —
8.85 million times, for text nothing ever displayed. `decode_facts_at` returns
the structure alone. This refines Stage D decision F1, which is amended in
[stage-d-plan.md](stage-d-plan.md): the rule is *never recover structure by
parsing text*, not *always produce text*.

**Descent bookkeeping was a `BTreeMap`/`BTreeSet` keyed by RVA.** Eight million
entries, `O(log n)` with a pointer chase per level — and the linear sweep asked
"visited?" about *every executable byte* in the image. Replaced by a flat byte
per address (`delver-analysis/src/state.rs`): visited flag in the top bit,
instruction length in the low four, since 15 bytes is the x86 maximum and fits
exactly. Sections are few and sorted, so an address becomes an index with a
short binary search.

Memory is one byte per byte of section raw data, so it is bounded by **file
size** rather than by anything the image declares — a header claiming a 4 GB
section cannot make it allocate. Overlapping sections are trimmed at
construction so an address can never alias onto two cells.

Progress notifications during indexing are back to being a nicety rather than a
requirement, though they will still be wanted for genuinely large targets.

**E1t · Focus bus** — `IDelverFocusService`, 11 tests. Every change carries an
`origin` so a view can ignore its own echo; without that, two views that can
each scroll the other ping-pong forever. History coalesces positions within
0x40 bytes, so scrolling a few instructions does not fill the back stack — the
thing that makes back/forward useless in tools that shipped without it.

The update type distinguishes "keep" from "clear" explicitly (`undefined` vs
`null`) rather than by key presence, which also avoids the banned `in` operator.

**Analysis session host** — `platform/delver/node/analysisSession.ts` starts
*both* processes and brokers the endpoint: `provider-file --listen <pipe>`, then
`server-analysis --provider <pipe> --listen <pipe>`. Endpoint names carry 8
random bytes, because the endpoint grants read access to whatever is attached
and a predictable name would let any local process connect. It waits for each
server's `listening on` line rather than sleeping — connecting before the bind
races, and that only fails on a loaded machine.

### Two things this turned up

**Stale staged binaries were shadowing the dev build.** `resolveBinary`
preferred `resources/delver/bin/` over `delver/target/debug/`, so the tests ran
a `provider-file` built before D1 added `--listen` and failed with a clap usage
error. Order flipped: the dev build wins where it exists, and a packaged build
has no `delver/target/` so the staged copy still wins there. Anyone running
`cargo build` and seeing no change was hitting this.

**Analysis did not scale to large images — now fixed.** See below.

Test targets are now generated in-process (`test/node/minimalPe.ts`) for the
same reason the corpus generates its samples: hermetic, fast, and no dependency
on a system binary. Session tests run in ~81 ms each instead of timing out.

**D6 · `server-analysis`** — owns the fact store for one target and serves the
`analysis/*` methods. Per P1 decision E1 it does *not* open the file; it
connects to a provider as an ordinary DTP client and pulls the bytes through.
That costs a little throughput and buys the thing that matters: the same code
path works when the bytes come from a live process or a hypervisor, so the
provider abstraction is exercised now rather than validated late.

Methods: `openImage`, `listingWindow`, `rowForAddress`, `addressForRow`,
`functions`, `xrefsTo`, `xrefsFrom`, `strings`. `listingWindow` is capped at
4096 rows — bounded output is a protocol rule, not a nicety.

**D5 · `delver-analysis`** — recursive descent from D2's seeds, then a linear
sweep over executable bytes descent never reached. `FunctionSource` is ordered
most-authoritative-first, and `is_authoritative()` is false only for
`LinearSweep`; `CallTarget` counts because something in the image demonstrably
calls it.

The instruction index (E4) is parallel `Vec<u64>`/`Vec<u32>` arrays, not a
`Vec<Instruction>` — one object per row is the storage mistake from data-model
§1. `row_for_address` requires an exact boundary; `row_containing` covers an
arbitrary address. Conflating those would silently hand the listing a wrong row.

### Stage D acceptance — passed

`delverctl analyze <file>` spawns `provider-file` and `server-analysis` as
separate processes and drives them over named pipes, which is the topology the
workbench will use.

| Target | Result |
| --- | --- |
| `x64-exception-directory` corpus sample | 3 instructions, 3 functions, 2 xrefs — the two `nop`s after an unconditional `jmp` are correctly *not* decoded |
| `notepad.exe` | 39,777 instructions · 2,669 functions · 10,303 xrefs · 3,704 strings, in ~1.1 s including process spawn |
| `kernel32.dll` | 136,217 instructions · 8,427 functions · 30,643 xrefs · 14,005 strings |

**The sweep is noisy and that is the point.** `notepad.exe` has 435
exception-directory seeds but 2,669 detected functions, so roughly 2,200 come
from linear sweep. Some are real functions without unwind info; many are
misaligned guesses. They are all labelled `LinearSweep` / `authoritative: false`,
and `delverctl` prints a `?` against them. Tightening the heuristic is a
worthwhile later pass; shipping it unlabelled would not have been.

**D4 · Golden corpus** — `delver/corpus`, 4 samples, 5 tests, 47 KB total.
`npm run delver:corpus` (exit 1 on drift) and `delver-corpus bless` to
re-record after an intentional change.

Samples are **synthesised, not committed binaries**. F4 requires them benign and
redistributable, and every binary used for smoke testing so far is a Windows
system DLL, which fails that outright. Generating them is small, deterministic,
reviewable as source, and lets the corpus carry edge cases that are hard to find
in the wild. `pe_builder.rs` emits valid PE32/PE32+ with sections, entry point,
import directory, and exception directory. They are parseable, deliberately not
loadable.

**The corpus paid for itself on its first run**, catching a layout bug in the
builder: `pdata_rva` was computed assuming `.rdata` existed, but the section
placement loop skips empty sections — so with no imports the exception directory
pointed at `0x3000` while `.pdata` sat at `0x2000`, yielding zero seeds. Fixed,
and `declared_directories_land_inside_a_real_section` now guards the class.

Regression behaviour verified by deliberately inverting the seed dedupe
priority: the check failed with a line diff naming the drifted field, exit 1.

**D3 · `delver-disasm`** — `iced-x86` behind a Delver-owned interface. 10 tests.
Three decisions are baked into the API, per
[stage-d-plan.md](stage-d-plan.md):

- **One decode pass yields text *and* structure** (F1) — formatted mnemonic and
  operands for the listing, plus `FlowKind`, resolved `branch_target`, and
  RIP-relative `memory_target` for D5's xref extraction. Re-parsing formatted
  text to recover a call target would be a parser on top of a parser.
- **Decoding never starts mid-instruction on its own authority** (F2).
  `decode_at` refuses an unanchored address and returns the anchor it was given
  instead of a plausible guess — the same principle as invariant 7.
- **Bitness is explicit, with no default** (F3). A test decodes the same three
  bytes as `mov rax,rbx` on x64 and `dec eax` on x86 to pin why.

**D2 · `delver-format`** — PE parsing moved out of `provider-file` into its own
`#![forbid(unsafe_code)]` crate, now covering imports (with IAT RVAs), exports
(including forwarders), relocations, TLS, and the exception directory as
function seeds. New protocol methods `getImports`, `getExports`,
`getFunctionSeeds`; `getImageInfo` stays a summary with counts so opening a
large DLL does not drag thousands of symbols with it.

Gates: `cargo test --workspace` **60 passing** · `npm run test-node --grep Delver` **14 passing** · `npm run delver:corpus` clean · `cargo clippy -- -D warnings`
clean · `cargo fmt --check` clean · `npm run typecheck-client` clean · eslint
clean on all Delver sources · schema and `protocol.generated.ts` regenerate
idempotently.

### Smoke tests run 2026-08-07

| Case | Result |
| --- | --- |
| x64 EXE (`notepad.exe`) | 50 modules, 315 imports, 435 seeds (all ExceptionDirectory) |
| DLL with forwarders (`kernel32.dll`) | 1671 exports incl. `-> NTDLL.Rtl…`; 2734 seeds = 1809 exception + 925 export |
| 32-bit PE (`SysWOW64\notepad.exe`) | `I386`, 1 seed (EntryPoint) — x86 has no exception directory, as expected |
| TLS image (`mshtml.dll`) | TLS directory + 1 callback parsed; callback deduped against the exception directory |
| Ordinal imports | render as `#413`, not blank |
| Non-PE input | clean `file is not a supported PE image`, no stray IO error |
| Partial read past section end | 258 bytes, `valid [0x28E00, 0x28F02)` — truncated, never zero-filled |
| Unmapped RVA / past EOF | 0 bytes, no valid ranges |
| `--listen` + new methods | served correctly over a named pipe |
| Two concurrent `connect-read` | distinct frame IDs (D1 regression clean) |

## E2t · Listing editor — done

`Delver: Open Listing` opens a disassembly editor. `contrib/delverListing`, with
the paging logic in `delverListingModel.ts` and 10 tests over it.

Reaching analysis from the renderer was most of the work: `DelverAnalysisSession`
lives in the node layer, so this adds `IDelverAnalysisService` over a
`delverAnalysis` shared-process channel, mirroring the target service. Every
payload on it is wire-shaped — addresses are `"0x..."` strings and are converted
to `bigint` on the renderer edge, for the reason recorded in ADR 0001 "Scope".

### Divergence from decision E4 — raise before relying on it

E4 justified the instruction index partly by *"a virtualized listing needs an
exact total row count"*, implying a list spanning the whole image. **That is not
what shipped, and it is not achievable on `WorkbenchTable`:** `ListView.splice`
allocates a per-row bookkeeping object, and 8.85M rows is hundreds of megabytes
before a single row is drawn.

The buffer slides instead — 20k rows held, recentred when the viewport comes
within 2k of an edge — which is what the debug disassembly view does. The index
is what makes it work, since recentring is an address→row lookup, so E4 still
earns its place. The cost is that the scrollbar spans the loaded window rather
than the whole file. Navigation to an arbitrary point is by address, which E3t
covers.

If a true full-file scrollbar is wanted, it needs a custom virtual scroller
rather than `WorkbenchTable`. That is a real piece of work and should be decided
deliberately, not discovered.

Three details worth keeping:

- **A list widget copies the elements it is given.** Filling rows in the model's
  array is invisible to the table, and `rerender()` faithfully redraws the stale
  placeholders — the first build showed thousands of rows, all blank. The model
  now reports the buffer range each page filled and the view splices exactly
  that range back. Replacing a range with the same number of rows leaves total
  height, and so the scroll position, untouched.
- Rows render as **placeholders** while their page is in flight; the fetch never
  blocks the scroll. A failed page stays unloaded so it retries on the way back
  rather than caching as empty, and the failure is reported rather than
  swallowed: a row that never fills is otherwise indistinguishable from one that
  is still loading.
- Recentring **keeps rows that survive the move**. Rebuilding the buffer from
  scratch would refetch pages already held and make every recentre flash.

The editor is the first real consumer of the focus bus: selecting a row
broadcasts its address, and a focus change from anywhere else scrolls to it,
with `origin` suppressing the echo. That was the design the bus was built for and
it now has a user.

## E3t · Navigation — done

The listing was scroll-only; it is now addressable.

| Command | Binding |
| --- | --- |
| `delver.navigate.goToAddress` | `Ctrl+G` |
| `delver.navigate.goToFunction` | — |
| `delver.navigate.back` / `.forward` | `Alt+Left` / `Alt+Right` |

All four are bound only while a listing is the active editor, so they never
shadow upstream keys elsewhere. Navigation publishes to the **focus bus** rather
than calling the editor, so it moves the listing without knowing it exists — and
anything added later follows for free.

**`IDelverSessionService`** is the new seam. The editor that opens a session owns
its lifetime, but navigation, and later the interpretation views, need to reach
it without reaching into that editor. Clearing is guarded by identity: opening a
second listing publishes its session before the first editor is disposed, so an
unguarded clear would blind navigation while a perfectly good listing is on
screen. That case is a test.

Two judgement calls worth knowing:

**Bare digits parse as hex.** The listing displays `0x1000`; typing what you read
has to land there. Reading `1000` as decimal would navigate somewhere plausible
and wrong, which is worse than an error. `0n4096` is available for decimal.
Anything wider than u64 is rejected as a typo rather than wrapped.

**Go to Function lists only authoritative boundaries.** A large module sweeps up
~178k guessed starts (node.exe), which would make the quick pick both unusable
and untrustworthy. A swept address is reached by typing it, not by browsing for
it — and this keeps the picker consistent with the principle that a guessed
boundary must never present like a compiler-emitted one.

**Go to String is deliberately not here**, despite being in the original E3t
sketch. Same quick-pick scale problem, and the 200k cap below means the list
would be silently incomplete. It belongs with the strings view.

## E4t · Per-view pin — done

`delver.listing.togglePin`, in the editor title bar, `Ctrl+G`-adjacent in the
command palette as **Delver: Pin Listing**. Pin is **per-view state, not bus
state** — pinning one listing must not change where anything else thinks it is
looking, which is why it lives on the editor rather than the focus service.

The rule that took thought: **a pinned view still follows explicit navigation and
history, and nothing else.** Pin exists to stop a view being dragged around by
*other* views — an agent following xrefs, a search result, another editor's
selection. A command the user invoked while looking at that view is not that, and
ignoring it would make Go to Address look broken on a pinned listing, which is a
worse failure than being dragged. `shouldFollowWhilePinned` is a pure function
with tests on both halves.

A pinned view keeps publishing its own selection: pin means *do not drag me*, not
*do not speak*.

This closes **Stage E**. The workbench now attaches a target, analyses it, shows
its sections, disassembles it, navigates by address and function, and remembers
where it has been.

## Traversal — follow, return, and references

E3t built navigation as *search* — type an address, pick from a list. That was
back to front. **Navigation in a disassembler is mostly traversal:** see a
reference, follow it, come back, dozens of times a minute. Typing an address is
the fallback you reach for a few times an hour. This adds the primary loop.

- **Enter follows** the selected row's branch target; **Escape returns**. That
  pairing is the muscle memory every disassembler shares, and it is worth more
  than the keys themselves.
- **Branch targets are links** — coloured, underlined on hover, clickable. An
  operand you can follow must not look like one you cannot, so an indirect call
  (no statically known target) stays plain rather than inviting a dead click.
  The click handler binds once per template and reads the target at click time,
  because templates are recycled as the list scrolls.
- **References view** (`delver.view.xrefs`) shows what reaches, and is reached
  by, the current focus. It follows the focus bus rather than the listing, so it
  works for anything that publishes a location.

Two things the References view has to get right:

It **does not filter its own origin**, unlike the listing. Clicking a reference
moves the focus, and the panel must then answer for where it just sent everyone.
Answering a question about a new address cannot feed back into another focus
change, so there is no echo to guard against — the guard the listing needs would
be a bug here.

Lookups are **generation-guarded**. Focus moves faster than two round trips, and
a stale answer arriving late would show references for somewhere the user had
already left.

### Correction: pin keys on reason, not origin

The E4t rule — a pinned view follows only the navigation and history origins —
was wrong, and the References view is what exposed it. A reference clicked in
that panel comes from a different view but is unmistakably *the user asking to go
somewhere*; refusing it would make pin feel broken rather than protective.

The distinction is **reason, not origin**. A pinned view now follows `User` and
`Navigation` and ignores `Ai`, `Script`, and `TargetEvent` — which is the real
thing pin protects against, and the one that matters more as P3 and P4 land.

## Delver has its own activity-bar container

`workbench.view.delver`, circuit-board icon, sitting after the built-in
containers. Sections and References moved out of the Explorer and into it.

Reverse engineering is the whole task here, not an accessory to editing files.
Borrowing the Explorer's container scattered Delver's views among file-tree
concerns and gave them no home to grow into — Stage F and G add several more.

The container lives in `services/delver/browser/delverViewContainer.ts`, not in a
contribution: **more than one contribution registers views into it**, and a
contribution must not import another contribution's internals (invariant 9). It
also removes the one place Delver code reached into an upstream contrib, which
was `explorerViewlet`.

`hideIfEmpty` is false and both views carry welcome content with a command link.
An activity-bar icon opening onto two empty trees reads as broken rather than as
waiting for a target.

**Hiding a view is permanent, and that is a trap.** VS Code persists a hidden
view and nothing un-hides it — so one click on "Hide Sections" removes part of
the workspace for good, and re-opening a target does not bring it back. That
reads as a bug rather than as a setting. Two things address it:

- **`Delver: Reset Views`** brings every Delver view back. The container keeps a
  roster of what registered into it (`registerDelverView`), so this needs no
  contribution to know another's view ids.
- **`Delver: Open Target` reveals the container**, without focus. The container
  only — a view the user hid stays hidden, because that was their choice.

## One target, one session, everything populated

**`Delver: Open Target` is now the single entry point.** It opens the listing,
and Sections and References fill in from the same session. Previously "Open File
Target" attached a provider for headers and "Open Listing" started a separate
analysis session — two providers on one file, and two things to remember before
the workspace looked complete. With the views side by side in one container that
was going to read as a bug.

Headers come from the **provider**, not the analysis server: `getImageInfo` is a
`TargetCapability`, and asking the analysis server to proxy it would put a
parsing concern in the wrong process. The session opens a second client on the
provider endpoint alongside the analysis server's — which is what P1 decision E1
made providers multi-client for, now actually exercised and covered by a test.

Both views guard their lookups with a generation counter. Sessions change faster
than a round trip, and a stale answer arriving late would describe an image the
user has already closed.

### Left behind: `IDelverTargetService` is now unwired

The sections view was its only consumer. It is still registered and still
tested, but nothing in the UI reaches it.

**Not deleted, and this needs a decision.** It models an *attached target* with
capabilities and address spaces, which is the right shape for P4 live-process
attach and is not something the file-only analysis session covers. Deleting it
would throw away a designed abstraction; leaving it is a registered singleton
with no callers. Worth resolving before Stage F rather than letting it rot.

## Next up — Stage G, the workspace panes

See **[stage-g-plan.md](stage-g-plan.md)**.

The container has two panes, one of which is empty until you click something.
The panes that carry the actual analysis — imports, exports, functions, strings
— **do not exist**, even though all of that data is parsed and already crossing
DTP. The backend ran ahead of the interface and the gap is now the whole
experience.

Order: ~~Imports~~ → ~~Functions~~ → ~~Overview~~ → ~~Exports~~ → ~~Strings~~ →
**polish (G6) is all that remains.**

**G4 · Exports** — flat list. A forwarded export has no address in this image at
all; it shows where it resolves to and is deliberately **not** navigable,
because there is nothing here to navigate to.

**G5 · Strings, and the cap fixed properly.** The 200k cap stays — it is a real
defence against a hostile file turning string extraction into an allocation
attack — but it no longer lies. `StringsResult` now carries `truncated`
(`delver-analysis` returns a `StringScan`), and the pane says which limit it hit:
the scan cap, or its own display cap of 2,000. Raising the cap would only have
moved the dishonesty; reporting it removes it.

Strings are **attacker-controlled text** rendered as tree labels, which are
plain text. Nothing interpolates them into markup, and nothing should.

**G2 · Functions** splits **compiler-vouched** from **found by sweep**, expanded
and collapsed respectively. That split is the point of the pane: a boundary the
image vouches for and one a sweep guessed at are different kinds of claim, and a
single flat list would flatten the difference the analysis works to preserve.
Swept entries are capped at 1,000 with a row saying how many were omitted —
nobody finds a function by scrolling past 178k addresses, and stopping silently
would be worse than saying so. A proper filter box and full virtualization are
the follow-up.

**G3 · Overview** answers "did anything load, and what is it" — file,
architecture, entry point, image base, and the four counts, each with an icon.

**G1 · Imports is done.** `contrib/delverImports`, a module → symbol tree in the
Delver container. Modules start collapsed on purpose: the read at a glance is
*which* libraries a file reaches for, and expanding everything buries that under
symbols. Clicking a symbol navigates to its IAT slot through the focus bus, so
the listing follows and References answers for it — every new pane inherits that
for free.

Imports come from the **provider**, like headers, over the session's second
client. Imports by ordinal show the ordinal rather than an invented name.

Verified against `notepad.exe`: 50 modules, 315 symbols, real IAT addresses.

Pane order is now set for the whole stage — Overview 10, Functions 20, Imports
30, Exports 40, Strings 50, Sections 60, References 70 — with Sections collapsed
by default, since it is consulted rather than read.

### A trap worth remembering

**A view's container is remembered per user, not taken from wherever the code
registered it.** Sections lived in the Explorer before Delver had its own
container, so it stayed there and re-registering it into Delver did nothing —
while References, a new view id with no history, appeared correctly. Any future
view that moves between containers hits this. `Delver: Reset Views` now detects
strays and moves them back.

Also on the list:

- **The string scan saturates its 200k cap** on large images, so the string list
  is silently truncated. A correctness question, not a speed one, and it now
  blocks both the strings view and Go to String.
- **Decide what happens to `IDelverTargetService`** — see above. Small, but it is
  a fork in the road rather than a chore.
- **Stage F — interpretation.** Names, comments, and the append-only authored
  store. This is what turns a listing into an analysis: every function is
  currently labelled by address because there is nothing else to call it.
- **Stage G — supporting views.** Strings, imports/exports, xrefs. The data is
  parsed and already crossing DTP; these are mostly UI, and the sidebar is still
  nearly bare.

Stage F is the bigger unlock, but it needs the string cap and the session
consolidation out of the way first — both are small.

## Rust status

Installed: `cargo 1.97.1`, `rustc 1.97.1`, default toolchain
`stable-x86_64-pc-windows-msvc`. `~/.cargo/bin` **is** on `PATH`.

For driving `delverctl` by hand, put the debug build on `PATH` rather than
`cargo install` — installed binaries are release snapshots that go stale on
every change:

```powershell
$env:PATH = "D:\Restricted\Delver\delver\target\debug;$env:PATH"
```

`delverctl` spawns `provider-file` by name, so both must be resolvable. The IDE
does not need this: `delverBinaries.ts` already resolves `delver/target/debug/`
in dev builds.

## Decisions

P0 decisions remain accepted. P1 decision E1 (named-pipe transport, provider
accepts multiple clients) is implemented. The unsafe-code exception in
`delver-rpc` is recorded in
[ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md).

- [ADR 0001](../history/adr/0001-wire-protocol-framing-and-encoding.md) — wire framing, hex-string numbers, error model
- [ADR 0002](../history/adr/0002-wire-types-separate-from-domain-types.md) — wire types separate from domain types
- [ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md) — bounded unsafe in `delver-rpc` Windows listener

D5 (crate picks, no async runtime) and D6 (file provider exposes `File` and
`Image` spaces) are recorded in [p0-plan.md](../history/plans/p0-plan.md) only.

## Known broken / stubbed

Nothing outstanding. Three items cleared on 2026-08-07:

- **`typecheck-client` now works** — it runs `tsc`, not `tsgo`. Its first run
  found two real errors that had never been caught: `delverSectionsView.ts`
  passed a bare `string` where `ITreeItem.label` needs `ITreeItemLabel` (so
  section names were most likely rendering blank), and it double-prefixed
  addresses as `0x0x1000` because they already arrive hex-encoded per ADR 0001.
- **The lint rules were verified against a probe file, and one was nearly
  inert.** `delver-no-target-kind-branch` only matched identifiers literally
  named `*target*`, so `descriptor.kind` and `this.target.kind` slipped
  through. Broadened, then narrowed to actual branching constructs (`===`,
  `switch`, `if`/ternary, `!`) so that reading a kind for display or asserting
  it in a test does not trip it — a rule that flags those gets disabled.
- **`cargo fmt --check` had never passed.** The whole workspace was
  unformatted; normalised in one mechanical pass. Semantics unchanged, all
  tests still pass.

## Not yet surfaced in the UI

D2's data — imports, exports, function seeds, TLS — is reachable only through
`delverctl` and the protocol. The workbench still shows just the sections tree.
Surfacing it is Stage G (`G2 · Imports / exports / sections trees`), after the
listing editor.

## Open questions

- Whether VS Code has a clean contribution point for injecting env vars into
  both the integrated terminal and notebook kernel processes. If it does, the
  `DELVER_SESSION` row in [PATCH-SURFACE.md](../development/patch-surface.md) disappears and
  scripting costs zero upstream edits.
- Ghidra decompiler version to pin, and how much of its source to vendor
  ([07-Roadmap.md](roadmap.md) P2b).

## Recently decided

- Priority is static RE + decompilation + AI before runtime (P1 → P2 → P3 → P4)
- Scripting is Python over DTP; no TypeScript extension API
- Minidump is the second provider, carrying abstraction validation while the
  debugger is deferred to P4
