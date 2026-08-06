# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [LEDGER.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-07
**Current phase:** P1 Stage E in progress — focus bus and analysis session done, listing editor next

## In flight

**Stage E** — E1t (focus bus) and the analysis session host are done. The
listing editor (E2t) is next.

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

**Analysis does not yet scale to large images.** `node.exe` is 92 MB and takes
**91 seconds** to analyse — 8.85M instructions, 178k functions, 1.87M xrefs, and
it saturates the 200k string cap. Fine for the 360 KB binaries used so far,
unacceptable as an interactive open. Progress notifications during indexing were
already deferred; this says they are a requirement, not a nicety, and the
indexing pass itself likely needs work before Stage E can open real targets.

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

## Next up

**E2t · Listing editor** — `DelverListingInput` + `EditorPane` +
`WorkbenchTable`. Read
`src/vs/workbench/contrib/debug/browser/disassemblyView.ts` first; it is the
same shape, and its comment about `WorkbenchTable` not supporting dynamic row
heights matters if inline source interleaving is ever wanted.

The data source pages over `analysis/listingWindow` through
`DelverAnalysisSession`, which is already wired. Rows must render as
placeholders while a page is in flight — the fetch must never block the scroll.

Then **E3t** (quick access: go to address/symbol/string, plus Alt+Left/Right on
the focus history) and **E4t** (per-view pin).

**Before opening anything large, address the indexing cost above.** A 92 MB
image taking 91 seconds is not an experience the listing can paper over.

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
