# Defect Audit — 2026-08-26, fix pass 2026-08-27

A full read of the codebase for **defects in what exists**, not gaps in what is
planned. Roadmap items live in [ledger.md](ledger.md); nothing here repeats them.

Four parallel read-only audits covered the Rust workspace, the TypeScript
platform/services layers, the workbench contributions plus the agent-bridge
extension, and doc/test drift. Findings were then verified against the code
before being listed.

**Delete a row when it is fixed.** A stale defect list is worse than none — the
same rule the design docs live under.

On 2026-08-27 every remaining row except #30 was fixed by eleven parallel agents,
each verifying its rows against the code before changing anything. The rows below
are what is *left*: one original item, plus thirteen defects the fix pass itself
surfaced. **Nothing from that pass has been compiled or run** — see
[Verification state](#verification-state).

---

## How to read the priority column

| Tier | Meaning |
| --- | --- |
| **P0** | Crashes, data loss, or a false claim about the sample. Fix before anything else. |
| **P1** | Wrong answers or wrong UI state that a user would act on. |
| **P2** | Real defects with bounded blast radius — leaks, error paths, drift. |

The ordering principle: **a wrong answer outranks a crash.** A crash is visible
and gets reported; a confident false claim about a binary is acted on. Items
that let Delver assert something untrue about a sample sort to the top of their
tier.

---

## What the fix pass corrected about this audit

Four rows named the wrong cause or the wrong size. Recorded because the same
mistakes are easy to repeat:

- **#13** blamed two call sites in `delverListingEditor.ts`. That file is now a
  74-line shell; the real cause was a misnamed constant — `ROW_HEIGHT = 22` is
  the *line* height, matching `line-height: 22px` in the CSS.
- **#33** named two files the product does not use. `IDelverTargetService` has no
  consumers outside its own registration; the pairs actually spawned come from
  `DelverAnalysisSession`. Fixing only the named files would have left the
  reported symptom — a sample locked after reload — fully intact.
- **#41** assumed the production path was duplicating the anchoring rule. It was
  not: the rule is discharged upstream through `InstructionIndex`, a stronger
  guarantee than the dead API's equality check. The API was removed, not wired in.
- **#6** named one `unwrap_or_default()` and six caps. A full read found **25**
  swallowed-error sites and all six unsignalled caps — including TLS directory
  failures reported as "no TLS", where callbacks run before the entry point.

Rows #56–#58 come from a different source: a real MCP trial against a live sample
on 2026-08-27, not a code read. They are worth keeping distinguishable, because
each survived four parallel audits and cost an actual caller time. The audits
found what is *wrong*; the trial found what *misleads* — a denial that reads as
authoritative, a target that changes without saying so, and a fixable
misconfiguration wearing the word "internal".

Two rows undersold the consequence. **#28**'s regex coercion accepted a 16-digit
*number* as a registry id and a one-element *array* as a fingerprint, on data
crossing a trust boundary. **#38**'s registry bound made a live rendezvous window
undiscoverable behind 256 stale entries — self-inflicting, since every crashed
window leaves one behind.

---

## P0 — crashes, data loss, false claims

| # | Defect | Where | Consequence |
| --- | --- | --- | --- |
| 56 | A string's reported address is the start of its *printable run*, not of the literal | `delver-analysis/src/strings.rs` `is_printable` | It accepts `0x20..0x7F` and tab, but not `
` or ``, so a literal beginning with a newline is reported one byte late. `search_strings` gave `0x797671` for a Python template whose referenced literal starts at `0x797670`. `xrefs_to` matches an exact address, so the address the strings view hands you answers `total: 0` with `completeness: "complete"` — a confident denial that the string is referenced at all. The caller recovered the real site only by dumping bytes and finding the literal boundary by hand |

## P1 — wrong answers, wrong state

| # | Defect | Where | Consequence |
| --- | --- | --- | --- |
| 43 | `analyze()` takes no coverage argument, so a partial read stops at the first hole | `delver-analysis/src/lib.rs`, `server-analysis/src/image.rs` | The residue of #5. Coverage is now *reported* (`coverage_complete`, `unreadable_ranges`), but sections past an unreadable hole are still never decoded — the alternative, zero-filling the gap to keep positions correct, would decode fabricated instructions, a worse P0. The real fix is teaching `analyze` about coverage |
| 44 | `RESULT_LIMIT_EXCEEDED` throws after a write handler has already committed | `delverAgentService.ts` `invoke` | The same class as #23, which the fix pass closed for `recordToolCall` only. `delver_propose_comment` allows 100 proposals × 16 KB against a 256 KB budget, so a large accepted batch commits and *then* reports failure. The agent re-proposes, duplicating append-only authored edits. Needs a tool-facing decision: stop echoing proposal `value`, or define a reduced write-result shape |
| 45 | `import_symbol_count` under-reports on a capped or failed thunk walk | `provider-file/src/lib.rs`, `delver-format/src/lib.rs` | Summed from returned lists. `ImportedModule` carries `symbols_failed`/`symbols_truncated` but no `symbol_total`, so no true total exists to source from — the last surviving instance of the count-from-page bug the #6 fix corrected for modules, exports and relocations |
| 57 | An MCP session binds to a workspace root; every call answers for whichever target is active *now* | `delverAgentService.ts` — each handler resolves `sessionService.activeSession` | Switching workspace tabs mid-session silently redirects every later call to a different binary, and nothing on the wire says so; it was noticed only because a `contentHash` changed between two calls. Findings anchor to `contentHash` so nothing is corrupted, and cursors are already validated against `contentHash`+`revisionId` — a *fresh* call has no such check. A caller-supplied target or revision pin, rejected on mismatch, is what closes it |
| 58 | Every non-tool request failure is flattened to `"Internal error"` | `delver-mcp/src/lib.rs`, the `Err(_)` arm reached with `tool_error: false` | The `tool_error` arms above it preserve `error.to_string()`; the catch-all discards it. `tools/list` is dispatched with `tool_error: false`, so a configuration problem the caller could fix — a root mismatch — arrives as an internal fault and sends them looking in the wrong place. Filed here rather than under P2's error paths because the blast radius is the caller's time, and it was the single most expensive item in the trial |

## P2 — bounded blast radius

| # | Defect | Where |
| --- | --- | --- |
| 30 | Invariant-9 violations: `delverSignaturesActions.ts` imports signature generation, `DelverListingInput` and `DELVER_NAVIGATION_ORIGIN` from **delverListing**; `delverListingNavigation.ts` imports `DelverPseudocodeInput` from **delverPseudocode**. 4 import statements, 2 files, 7 symbols — smaller than the "eight" originally recorded. The fix is moving signature generation and the editor inputs to `services/delver/browser/`, which is a placement decision, not a mechanical move |
| 46 | A row splice is not height-neutral and the scroll offset is not compensated | `delverListingWidget.ts` `onDidChangeRows` — a page arriving above the viewport slides the listing under the analyst's cursor mid-read, and does not self-correct. `ListingLineMap` now has what a fix needs: line count before vs. after `refresh`, times `LISTING_LINE_HEIGHT` |
| 47 | `delver-rpc` has `accept_shutdownable` but no `connect_shutdownable` | `listener.rs`, `listener_windows.rs` — `connect` returns two independent handles onto one connection, so dropping the write half never unblocks the reader. Forces `delver-mcp`'s reader join to be time-bounded rather than clean |
| 48 | `agent-bridge-relay/src/lib.rs` uses `deny(unsafe_code)` where `forbid` would do | The ADR 0003/0010 carve-out spilled one crate too far; the relay lib contains no `unsafe` |
| 49 | `listener_windows.rs` has zero SAFETY comments across ~25 `unsafe` blocks | The module [ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md) was written about is the least-documented of the three. Named as debt by [ADR 0010](../history/adr/0010-unsafe-code-in-os-security-modules.md) |
| 50 | `CallPathsResult.bounded` describes the source function's extent only | `message.rs` — frontier functions with inferred extents carry no flag. An extent that cannot be derived at all already clears `search_exhausted`, so this is narrower than #18, not the same gap |
| 51 | `GetImageInfoResult` carries redundant pairs | `import_module_count`/`import_module_total`, `export_count`/`export_total`, `relocation_count`/`relocation_total` always hold the same value, because the result carries no lists. Both are set from one source so they cannot disagree; the honest resolution is to collapse each pair |
| 52 | The string scanner caps entry *count* but not string *length* | `server-analysis/src/main.rs` — a 65 536-entry `analysis/strings` response can still exceed `MAX_JSON_FRAME_BYTES` on a sample with megabyte-long printable runs. Needs a byte budget, which is not a recorded decision |
| 53 | `adoptSession` leaves `session.projectPath` undefined and keys `sessions` by the offline path | `delverSessionService.ts` — a plainly-opened target whose project is known still reports no project path, and after a successful attach `setActiveTarget(session.targetPath)` cannot find its own session. Fixing it breaks an existing identity-check test, so it is drift to decide on, not a mechanical fix |
| 54 | `delver-format` has no export-directory regression test | A `.exe` has no export directory, so the `current_exe` fixture cannot reach that path, and `corpus`'s `PeBuilder` cannot be used (it depends on `delver-format`, so a dev-dependency would cycle). Needs export emission in `PeBuilder`, or a minimal builder in `delver-format`'s own tests |
| 55 | Nothing connects an import-table parse failure to the unresolved call sites it explains | `call_graph.rs` — when `imports_failed` is set, indirect-call resolution silently loses its evidence and the call graph reports unresolved sites with no stated cause |

---

## Themes worth fixing as themes

**Truncation without a signal.** The original #5, #6, #18, #19 and the corpus
snapshot were one bug repeated: a bound is applied and nothing on the wire says
so. `StringScan.truncated` is the pattern that got it right. The fix pass adopted
it across `ParseCompleteness`, the four bounded analysis results and the image
read — but #45, #50, #51 and #52 show the theme is not fully discharged. The
review question for any new bounded result stays: *what field says this was
bounded?*

**Counting the page, not the image.** A sharper instance of the same theme, and
worth its own name because it reads as correct: `import_module_count`,
`export_count` and `relocation_count` were all computed from post-cap lists, so a
truncated parse reported a page size as an image total. Three were fixed; #45
remains. Any `*_count` derived from a list that can be bounded is suspect.

**One question, two implementations.** #13, #16 and the
`is_local_endpoint`/`is_registry_id` pairs were all cases where a rule is
implemented correctly in one place and re-derived incorrectly in another. Both
fixes deleted the second implementation rather than repairing it, which is the
standing preference. #30 is the remaining instance, at module scale.

**Errors that cannot survive a process boundary.** `instanceof CancellationError`
was wrong in four places across three files, for one reason: the shared-process
channel rebuilds rejections from `{message, name, stack}`, so the prototype is
gone. Identity checks on errors crossing IPC are always wrong here — match by
name. The two worst instances reported a user's own cancellation as
`DECOMPILER_UNAVAILABLE` and as `INTERNAL_ERROR`, a code an agent is entitled to
retry.

**Docs asserting safety the code does not provide.** The original #42 and
[ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md)'s "only
module permitted to use `unsafe`" are the same failure — worse than missing docs,
because they stop the next reader from checking. #49 is what remains of it.

---

## Not covered by this audit

The agent-bridge transport internals were only partially read. The 2026-08-27
pass swept `relaySupervisor.ts`, `bootstrapRelayTransport.ts`, `bootstrap.ts`,
`rendezvousLifecycle.ts` and `rootFingerprint.ts` for the *orphaned-child and
unhandled-listener* class specifically, and found one further instance
(`relaySupervisor.ts:137`, fixed). That class can now be treated as swept; every
other class in those files remains unknown rather than clean.

## Verification state

**Nothing from the 2026-08-27 fix pass has been compiled, typechecked, or run.**
Per `CLAUDE.md` rule 15 the agents wrote regression tests but executed nothing.
The state recorded below is from before the pass and is now stale.

Required before the pass can be verified, in order:

1. **`npm run delver:protocol`** — the wire changed and the generated files are
   behind. `MomentWire.epoch` and `TlsWire.raw_data_size` are now hex strings
   (ADR 0001); `OpenImageResult` gained `decoding`, `fully_parsed`,
   `coverage_complete`, `bytes_read` and `unreadable_ranges`; six other result
   types gained completeness or bound fields. Until this runs,
   `protocol.generated.ts` still declares `epoch: number` and the TypeScript side
   disagrees with the Rust side.
2. **Rebuild and re-stage `provider-file.exe` and `server-analysis.exe`.** The new
   wire fields are required, not `serde(default)` — deliberately, so a stale
   binary fails loudly rather than answering half a shape. Expect every analysis
   integration test to fail until this happens.
3. `cargo test` across the workspace, then `typecheck-client`, then the Delver
   TypeScript suites.

Known-stale from the prior pass: `provider-file.exe` and `server-analysis.exe`
were locked by a running Delver instance, so six `DelverAnalysisSession`
integration tests failed with `UnsupportedCapability: method analysis/callGraph
is not supported` — stale binaries, not logic. The generated PE import fixture in
`minimalPe.ts` is unverified until those binaries are rebuilt.

One behaviour change to expect on the first green run: fixing #16 unified the two
"where does the last function end" implementations, which changes the digest of
the **last function in every image**. Normalization is bumped
`delver-server-listing-v2` → `v3`, so stored v2 fingerprints match nothing. That
is the fail-safe direction, and matches the precedent recorded for the `Indirect`
split.
