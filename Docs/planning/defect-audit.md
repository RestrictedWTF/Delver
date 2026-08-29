# Defect Audit — 2026-08-26, fix passes 2026-08-27, 2026-08-28 and 2026-08-29

A full read of the codebase for **defects in what exists**, not gaps in what is
planned. Roadmap items live in [ledger.md](ledger.md); nothing here repeats them.

Four parallel read-only audits covered the Rust workspace, the TypeScript
platform/services layers, the workbench contributions plus the agent-bridge
extension, and doc/test drift. Findings were then verified against the code
before being listed.

**Delete a row when it is fixed.** A stale defect list is worse than none — the
same rule the design docs live under.

**Every row is now closed.** The 2026-08-27 pass fixed all but #30 and surfaced
thirteen further defects; the 2026-08-28 pass verified each survivor against the
code and closed the last two; the 2026-08-29 pass ran over the *uncommitted*
session work and found ten more, all now fixed and verified against a green tree.
What remains below is the part worth keeping: the themes, and what the passes got
wrong about themselves.

---

## How to read the priority column

The rows are gone, but the ranking they used is the durable part:

| Tier | Meaning |
| --- | --- |
| **P0** | Crashes, data loss, or a false claim about the sample. Fix before anything else. |
| **P1** | Wrong answers or wrong UI state that a user would act on. |
| **P2** | Real defects with bounded blast radius — leaks, error paths, drift. |

The ordering principle: **a wrong answer outranks a crash.** A crash is visible
and gets reported; a confident false claim about a binary is acted on. Items
that let Delver assert something untrue about a sample sort to the top of their
tier. The ranking held up under both passes.

---

## What the fix passes corrected about this audit

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

Two rows undersold the consequence. **#28**'s regex coercion accepted a 16-digit
*number* as a registry id and a one-element *array* as a fingerprint, on data
crossing a trust boundary. **#38**'s registry bound made a live rendezvous window
undiscoverable behind 256 stale entries — self-inflicting, since every crashed
window leaves one behind.

Rows #56–#58 came from a different source: a real MCP trial against a live sample
on 2026-08-27, not a code read. They were worth keeping distinguishable, because
each survived four parallel audits and cost an actual caller time. The audits
found what is *wrong*; the trial found what *misleads* — a denial that reads as
authoritative, a target that changes without saying so, and a fixable
misconfiguration wearing the word "internal".

**And one thing the 2026-08-28 pass corrected about the 2026-08-27 pass: the
list outlived the work.** Eleven of the thirteen rows the fix pass surfaced were
already fixed in the tree when the next session opened the file, but no row had
been deleted, so the audit claimed thirteen open defects and had two. A list that
overstates what is broken costs the next reader the same re-verification the
list existed to save. Deleting the row *is* part of the fix.

---

## The last two, and why they were the last two

Both were failures to tell the truth *after* something had already happened —
the hardest class to notice by reading, because the code that lies is correct
code sitting one statement too late.

**#44 — `RESULT_LIMIT_EXCEEDED` after a write handler committed**
(`delverAgentService.ts` `invoke`). The dispatcher measured the serialized
envelope and threw if it was over budget. For a read that is the useful answer.
For a write the proposals or findings are already appended to an append-only
log, so the caller is told a write it made did not happen — and an agent's
correct response to a failed write is to make it again. `delver_report_finding`
echoes 50 titles, descriptions and evidence texts back at the caller against a
256 KB budget, so a 20-finding batch at the per-finding character bound clears
the limit on its own. Handlers now supply a `reducedData` payload keeping only
what the caller cannot reconstruct — the record identities — and an oversized
*write* result is reduced, marked `partial`, and says so, rather than being
reported as a failure. This follows the precedent already set immediately below
it, where retention failure after a commit returns the result with a provenance
note instead of throwing.

**#58 — every non-tool request failure flattened to `"Internal error"`**
(`delver-mcp/src/lib.rs`). The `tool_error` arms preserved `error.to_string()`;
the catch-all discarded it. `tools/list` is dispatched with `tool_error: false`,
so a root that matches no published window — the one failure the caller can
actually fix — arrived as an internal fault. Every `BackendError` message is
written to be safe to return, so the message now survives whichever arm the
failure takes, and an `InvalidParams` kind maps to `INVALID_PARAMS` regardless
of which method produced it.

---

## The 2026-08-29 pass — over uncommitted work

Same shape as the others: four parallel read-only agents over the Rust
workspace, the platform layer, the workbench services, and the contribs plus
test quality, each verifying a finding against the code before reporting it.
Same ranking. The difference is the scope — **this pass read work that had not
been committed yet**, which is the cheapest place to run it: the reasoning that
produced the code is still recoverable, and nothing has been built on top.

Every row it found is fixed. They are not listed, per the rule above. What is
worth keeping is that **none of the classes were new**.

**A second bound never read.** `IStringsResult`, `IFunctionsResult`,
`IGetImportsResult` and `IGetExportsResult` each carry two independent
completeness signals — a scanner cap applied when the image was analysed, and a
response bound applied on every call — and four agent handlers read one. Proven
worst case: `delver_search_strings` returned zero matches marked **complete**
having examined 2 of 70,000 strings, because the response bound fired while the
scanner cap did not. The same defect had been fixed in `handleXrefs` earlier in
the same session and left in its siblings. Alongside it, `OpenImageResult`
omitted `strings_truncated` — a field already on the struct it was built from —
so a capped image reported exactly `string_count: 200000` unqualified. This is
[Truncation without a signal](#themes-worth-fixing-as-themes) again, with a
sharper edge: it is no longer "no field says this was bounded" but **"a field
says it and nobody reads it."** The review question grows a second half: *what
field says this was bounded, and does every consumer read all of them?*

**A cursor stable only until something re-derives.** `XrefIndexParams.start` was
documented as safe because "the table is built once when the image is analysed
and never mutated". `analysis/setCorrections` then made re-derivation a normal
operation — `reanalyze` replaces the whole `AnalyzedImage` while the image handle
survives — and the documented invariant was false without a line of the cursor
code changing. A walk spanning a correction skips or duplicates rows and ends
early, and a table retained from it answers a later "who references this" with
the confident zero [ADR 0012](../history/adr/0012-retained-xref-table-in-portable-projects.md)
exists to prevent. The fix is a `generation` counter on the loaded image, echoed
in the result and optional in the params, with a mismatch refused naming both
derivations. The durable form: **a cursor's stability is a claim about every
other operation on the same handle, and a new mutating operation invalidates it
silently.** Adding one is the moment to re-read every cursor's justification.

**Two more of the standing themes, unchanged in shape.** `setCorrections`
reported function and instruction counts with no `decoding` field, so on an
unsupported architecture the reply read "your correction applied and the image
has zero functions" — [Counting the page, not the
image](#themes-worth-fixing-as-themes), one step out. And
`analysis/scanStrings` shipped with no byte budget while its sibling
`analysis/strings` has both a count bound and `STRING_LIST_JSON_BUDGET`, where an
oversized frame kills the analysis server outright — one question, two
implementations, and only one of them complete.

**One class the earlier passes had not named: the fact re-derivation nothing
watched.** `setCorrections` is the only operation whose entire purpose is
re-deriving facts, and it was the only one no view listened for — `isSemanticOp`
omitted `FunctionBounds` and no contrib subscribed. A new
`IDelverSessionService.onDidRederiveFacts`, fired only after the server confirms
the re-derivation, now drives the pseudocode pane and the Functions view. The
general form is worth the row: **when an operation invalidates derived state, ask
what refreshes, not just what is correct.**

### Tests that could not fail

Three findings were about the audit's own safety net, and they matter more than
their tier suggests.

- A `toolCount: DELVER_AGENT_CAPABILITIES.length` assertion **could never fail**,
  because the tool list is built by mapping that same list. It had *replaced* a
  literal that could — a tidy-looking edit that removed the only thing the
  assertion was for. It now pins the set of no-argument tools *and* keeps a
  literal count, and was verified to fail by forcing a capability onto the
  fallback presentation path.
- A refusal assertion accepted any rejection and compared facts by count only. It
  now names the conflict and compares function identity.
- The pseudocode reload classifier had no test at all, despite having been wrong
  twice. `isSemanticOp` is exported and covered.

The tell for the first is structural, not about tests specifically: **an
assertion whose expected value is computed from the same source as the actual
one is a tautology.** A literal in a test is not duplication; it is the test.

### And what the pass found about the verification

The largest finding was not a defect in the code. `scripts\test.bat --grep
Delver`, used for verification throughout the session, **misses six suites**
whose names do not begin with "Delver" — `GhidraDecompilerProtocol`,
`GhidraHeadlessDecompiler`, `PyGhidraDecompiler`, `DecompilerWorkerHost`,
`InterpretationLog` and `provider exit escalation`. Three cover files the session
modified, and one test had been red for hours behind the filter. Every recorded
"N passing" figure after the v1→v2 semantic-snapshot normalization was a subset
reported as a whole. It is written up in
[working-with-ai.md §8](../development/working-with-ai.md), because it belongs
where the next session looks for how to run the tests, not in an audit it may
never open.

---

## Themes worth fixing as themes

**Truncation without a signal.** The original #5, #6, #18, #19 and the corpus
snapshot were one bug repeated: a bound is applied and nothing on the wire says
so. `StringScan.truncated` is the pattern that got it right, and it is now
carried across `ParseCompleteness`, the bounded analysis results, the image read,
the string-list byte budget, and the reduced write result. The review question
for any new bounded result stays: *what field says this was bounded?*

**Counting the page, not the image.** A sharper instance of the same theme, and
worth its own name because it reads as correct: `import_module_count`,
`export_count`, `relocation_count` and `import_symbol_count` were all computed
from post-cap lists, so a truncated parse reported a page size as an image total.
Any `*_count` derived from a list that can be bounded is suspect. The resolution
that stuck was making the count `Option` and absent when the walk was cut, rather
than reporting a number nobody can interpret.

**One question, two implementations.** #13, #16 and the
`is_local_endpoint`/`is_registry_id` pairs were all cases where a rule is
implemented correctly in one place and re-derived incorrectly in another. Every
fix deleted the second implementation rather than repairing it, which is the
standing preference. #30 was the same failure at module scale, and its fix moved
the shared code to `services/delver/browser/` rather than duplicating it.

**Errors that cannot survive a process boundary.** `instanceof CancellationError`
was wrong in four places across three files, for one reason: the shared-process
channel rebuilds rejections from `{message, name, stack}`, so the prototype is
gone. Identity checks on errors crossing IPC are always wrong here — match by
name. The two worst instances reported a user's own cancellation as
`DECOMPILER_UNAVAILABLE` and as `INTERNAL_ERROR`, a code an agent is entitled to
retry. #58 is the same family seen from the other side: a message discarded at a
boundary rather than a type.

**Failing a caller for something that already succeeded.** #23, #44 and the
retention path are one rule, learned three times: once a handler has committed to
an append-only log, nothing downstream of it may report failure. Cancellation,
byte budgets and bookkeeping all have to become *reductions with a stated reason*
past that line. The tell is any `throw` that sits below a commit.

**Docs asserting safety the code does not provide.** The original #42 and
[ADR 0003](../history/adr/0003-unsafe-code-in-transport-listener.md)'s "only
module permitted to use `unsafe`" are the same failure — worse than missing docs,
because they stop the next reader from checking.
[ADR 0010](../history/adr/0010-unsafe-code-in-os-security-modules.md) supersedes
it, and `listener_windows.rs` now carries a SAFETY comment on every one of its 23
`unsafe` blocks.

---

## Not covered by this audit

The agent-bridge transport internals were only partially read. The 2026-08-27
pass swept `relaySupervisor.ts`, `bootstrapRelayTransport.ts`, `bootstrap.ts`,
`rendezvousLifecycle.ts` and `rootFingerprint.ts` for the *orphaned-child and
unhandled-listener* class specifically, and found one further instance
(`relaySupervisor.ts:137`, fixed). That class can now be treated as swept; every
other class in those files remains unknown rather than clean.

## Verification state

**The 2026-08-29 pass is verified against a green tree**: Rust 234 passing,
Delver TypeScript 397 passing under the full suite selection, Python worker 10,
corpus 6/6, client typecheck, fresh transpilation and `valid-layers-check` clean.
Counts and the exact invocation are in [status.md](status.md).

**The first two fix passes were verified on 2026-08-28.** All four steps ran green:

1. **`npm run delver:protocol`** — `protocol.generated.ts` declares `epoch:
   string` and carries `import_resolution_incomplete`, `coverage_complete`,
   `unreadable_ranges` and the other new completeness fields, so the TypeScript
   and Rust sides agree again.
2. **`cargo build --workspace`, then `npm run delver:build`.** Both the debug
   binaries the tests resolve and the staged release copies were rebuilt.
3. **`cargo test --workspace`** — 195 passing. **`npm run typecheck-client`** —
   clean. **Delver TypeScript suites** — 318 passing. (That figure was taken with
   `--grep Delver` and so counted a subset; see the 2026-08-29 pass above.)
4. **`npm run delver:corpus`** — 6 samples match.

Two things only the first green run could have surfaced, both now fixed:

- **Four `DelverAnalysisSession` expectations were stale, in the direction the
  plan did not predict.** The worry was that a *stale binary* would fail against
  required new fields. What actually happened is the reverse: a fresh binary
  emitted `bounded`, `block_total`, `edge_total`, `import_resolution_incomplete`,
  `name_unreadable`, `symbol_total`, `symbols_failed` and `symbols_truncated`,
  and four `deepStrictEqual` expectations written before those fields existed
  rejected them. The expectations now assert every completeness field, because a
  test that elided them would pass just as happily against a parser that had
  given up.
- **`resequence` materialized `compensates: undefined` and `resolves: undefined`
  on imported edits that carried neither.** An own property holding `undefined`
  is not an absent one — to `deepStrictEqual`, to `in`, or to anything
  enumerating keys — so an imported edit stopped comparing equal to the
  identical edit that never went through an import. The function's own comment
  already said absent is how "no references" is spelled; the code did not do it.
  Note the fix could not simply drop the assignment: spreading and then
  conditionally re-adding would have kept the *original* references on an edit
  whose set was fully unmappable, which is the case `remap` exists to collapse.

One behaviour change to expect on the first green run: fixing #16 unified the two
"where does the last function end" implementations, which changes the digest of
the **last function in every image**. Normalization is bumped
`delver-server-listing-v2` → `v3`, so stored v2 fingerprints match nothing. That
is the fail-safe direction, and matches the precedent recorded for the `Indirect`
split.

New regression tests from the 2026-08-28 pass, both unrun:

- `delverAgentService.test.ts` — "an oversized write result is reduced rather
  than reported as a failure": 20 findings at the description bound, asserting
  `partial`, the surviving ids, the cleared provenance addresses, and that the
  reduced envelope fits.
- `delver-mcp/src/lib.rs` — `non_tool_failures_keep_their_message_instead_of_
  reading_as_an_internal_fault`: a backend whose `list_tools` fails, asserting
  the message reaches the client instead of `"Internal error"`.
