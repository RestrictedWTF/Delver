# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/). For what is *wrong*
with what exists, see [defect-audit.md](defect-audit.md) — a full read of the
codebase on 2026-08-26, ranked, with the fixed rows deleted as they land.

---

**Last updated:** 2026-08-29
**Current phase:** P3c/P3d — reviewed evidence plus static-analysis depth (P3b client conformance and P3a/P2b real-project smoke continue alongside)

## Just landed

**Review has modes.** `delver.review.mode` is `manual` (the default) or
`auto`; it is registered `RESOURCE`-scoped, so a workspace can override a
permissive user default and not the reverse, and an unrecognised value settles
to `manual` because the two failure directions are not symmetric — defaulting
to manual costs clicking, defaulting to auto accepts a model's claims nobody
asked it to accept.

The mode selects whether proposals wait. It does **not** select what the record
says, and that distinction is most of the work
([ADR 0016](../history/adr/0016-review-modes-and-the-automatic-reviewer.md)).
Under `auto` a proposal is still appended as a proposal and then decided by a
second append authored by `{ kind: 'rule', id: 'delver.review.mode' }` — the
author kind the data model already had for exactly this. Writing it straight to
`accepted` would have been one line shorter and would have destroyed the only
evidence that nobody read it. Findings are decided the same way, and each
finding's own `status` stays `proposed`, because that field records what the
model claimed while the decision records what happened to it.

Every surface that reports a decision now distinguishes the two. The exported
report gives automatically accepted findings their own heading — *Accepted
automatically — no human reviewed these* — rather than a variant of *Accepted*,
and states the policy in the summary block where a reader who skims and stops
will see it. `delver_capabilities` reports `reviewMode`, because under `auto` a
proposal is not provisional and an agent saying "I have proposed this for your
review" would be describing something that already happened without the
analyst.

**The cost is real and is not a defect.** Automatic acceptance covers
corrections, so an accepted `data` range that is wrong can erase most of the
function list before anyone is asked. The mitigation is that the correction is
recorded, the re-derivation is announced, and a refused set is surfaced rather
than swallowed — all of which landed earlier today.


**Four things landed: an agent can read its own findings back, an analyst can
say that a run of bytes is data, not code, a caller can ask for a re-derivation
without authoring anything to force one, and an investigation exports as a
report whose every claim links to its evidence.**

**Findings were write-only.** `delver_report_finding` wrote and nothing read, so
S6's exit criterion — *resumes from unresolved work without replaying chat
history* — was entirely absent rather than partly met: the only way an agent
could recover what it had already found was to re-read the conversation that
produced it. `delver_list_findings` is the thirty-sixth capability. It pages like
every other inventory capability, with a revision-bound cursor and a `filter`
over its `status` argument, which is `all`, `undecided`, `accepted` or
`rejected`. An unrecognised value is refused with `INVALID_ARGUMENT` rather than
quietly answered as `all` — a fabricated complete answer to a question nobody
asked is the worse failure, and this project ranks it that way everywhere else.
Each finding is paired with `findingDecisionFor`, so `decision` is absent exactly
when a human has not reviewed it, and `undecidedTotal` is reported beside
`total`, because the unresolved count is the number a resuming caller acts on.
The cursor's state stamp is `['findings', count, decidedCount]`: both logs are
append-only, so counting them is enough to tell one view of them from another.
The result is `untrusted: true`, since finding text can quote sample-derived
strings. The tool schema is in `delverAIToolDefinitions.ts`.

**A run of bytes can now be declared data, not code.** Until now the only
corrections were `define` and `undefine` of a function start, and neither says
anything about whether the bytes are code at all. A `DataRangeCorrection { rva,
end_rva }` excludes a half-open range from the derivation: it is not decoded, no
function start is admitted inside it from any source — seed, call target or
sweep — and it originates no cross-reference. A cross-reference *targeting* the
range survives, because a pointer into a table is exactly the evidence that made
it data. Strings are unaffected.

**It needed no new `EditOp`.** A data range reuses `EditOp.FunctionBounds` at the
same `(contentHash, rva)` anchor, with canonical JSON
`{"kind":"data","endRva":"0x..."}`. "A function starts here", "the function
detected here is not one", and "these bytes are not code at all" are three
mutually exclusive answers to one question about one address, and sharing one
slot is what makes them exclusive rather than merely inconsistent — a second
answer supersedes the first instead of sitting beside it. It also cost nothing:
no store migration, no new review-view op case, no new interpretation view field.

Three decisions worth carrying:

- **`endRva` is mandatory for `data`**, where it is optional for `define`. An
  unbounded "data starts here" would have to be guessed at, and guessing too
  large silently deletes real functions.
- **A `data` range is deliberately not checked against executable mapping**,
  unlike a `define`. A range an analyst calls data is usually *inside* an
  executable section — that is the mistake being corrected — so a
  mapped-executable test would refuse every useful case.
- **An instruction that starts outside a range but reads into it is excluded**,
  along with the xref and the function it derives from those bytes. An analyst
  draws the boundary at the table's true start, not at whatever boundary the bad
  decode produced, so the instruction before it routinely reaches in for an
  operand — and a `call rel32` with an excluded displacement invents a function
  at whatever those bytes spell. Checking only the start address kept all three.
  Found by audit after the first version shipped, not by design.
- **The sweep steps over a range rather than through it, and that is a cost
  optimisation, not a correctness guard.** `add_function` and `walk` already
  refuse, so replacing the stride with `rva += 1` leaves every test passing. The
  first write-up of this claimed it as the `rva+1` trap in a second form; it is
  not, and the audit that measured it is the reason this line is here.

In Rust, `Corrections<'a> { functions, data_ranges }` is a borrowed view with
`From<&[FunctionCorrection]>` impls, so existing call sites compile untouched.
Three conflict variants join the existing ones — `EmptyDataRange`,
`OverlappingDataRanges` (nesting counts as an overlap; abutting at an exclusive
end does not), and `DefineInsideDataRange`. An `undefine` inside a range is
allowed: redundant, not contradictory. A conflicting set is refused whole and
nothing is applied, as before. On the wire, `DataRangeCorrectionWire` carries the
range, `data_ranges` joins `OpenImageParams` and `SetCorrectionsParams`, and
`SetCorrectionsResult` reports `data_ranges_applied` **apart from**
`corrections_applied`, because one data range can silence many detected functions
and a single total could not say which kind of assertion did it. In TypeScript,
`functionCorrectionsFor` became `authoredCorrectionsFor` returning
`{ functions, dataRanges }`, `delver_propose_function` accepts `kind: "data"`,
and Review labels the row "Treat X through Y as data, not code". ADR 0015 is
amended with all of it.

**Regenerating `protocol.generated.ts` also revealed that it had been stale.** It
picked up three fields added to the `delver-protocol` crate in earlier sessions
and never regenerated: `strings_truncated` on `OpenImageResult`, and `decoding`
and `generation` on `SetCorrectionsResult`. Invariant 12 says the generated files
are generated; it does not say when, and the gap is where the drift lived.

**A re-derivation can now be asked for.** `delver_reanalyze` is the
thirty-seventh capability and closes S5's forced-reanalysis bullet. It takes no
arguments — it re-derives the whole image or it does nothing, so there is no
subject to name. Before it, `analysis/setCorrections` was pushed only by the
session service, at open and when an accepted `functionBounds` edit landed, so a
caller who merely wanted to know whether its answers were current had to author
a correction to find out. It authors nothing and modifies no bytes, but it is
priced as a write because it invalidates state the caller holds: every cursor
and every table index taken before the call indexes a table that no longer
exists. So the result carries `generation` — what lets a stale cursor be refused
rather than answered from the rebuilt table — and `decoding`, without which
every count in it is an unqualified zero on an architecture the decoder does not
support. It requires an attached sample and refuses with `TARGET_NOT_ATTACHED`
otherwise. `functionCountObservedBefore` comes from a listing taken before the
call rather than from the server's own `function_count_before`, so the two
agreeing is evidence rather than a tautology.

**An investigation exports as a report.** `delver_export_report` is the
thirty-eighth capability and closes the second half of S6's exit criterion.
`delverFindingReport.ts` renders the retained findings as Markdown and is a
pure function of what the project already holds — findings, decisions,
tool-call records — reading no bytes at all, so it works on a `.delverdb`
handed to someone who never had the sample. That is the case a report exists
for; a renderer that touched the target would be useless exactly when it is
needed. Findings are grouped by the human decision on them, and an unreviewed
one is rendered as unreviewed rather than beside the accepted conclusions:
presenting proposed model output as established is the false-claim failure this
project ranks above a crash. Rejected findings are kept, because ruling
something out is a result and re-deriving it costs the next reader the work it
cost the first. An empty report says the *investigation* retained nothing, never
that the sample is clean. Past the serialized limit it is refused with its size
rather than prefix-truncated, since a report cut mid-claim has lost the evidence
for whichever claim it was cut inside.

**One design question was raised rather than answered**, per invariant 14:
adjusting the bounds of an existing function as a single operation. The shape
that fits is a `relocate` correction on the existing entry point, lowering to
`Undefine(old) + Define(new)`, but two forks make it a decision rather than an
implementation — whether the lowering belongs in the workbench or the analysis
crate, and what should happen when the lowered `Define` collides with a
correction already authored at that address, since the server refuses a
conflicting set whole and the current push swallows that failure. Both are
written up in the S5 section of
[mcp-complete-session-plan.md](mcp-complete-session-plan.md).

**Two audits ran over this work, and both found real defects.** Every row below
is fixed and pinned by a test that was verified to fail without the fix.

- **P0 — the report could be made to forge its own structure.** Finding text is
  written by a model reading the sample's strings, and `boundedText` trims but
  permits embedded newlines. A description could therefore open a
  `## Accepted findings` section and a `- **Review:** accepted by <name>` line
  that no human ever recorded, inside the one artifact built to be forwarded to
  someone who cannot check it. Every piece of finding-derived text is now
  neutralized: titles and evidence lines collapse to one line, prose has its
  line-leading Markdown markers escaped. The text stays readable — it is
  evidence and must be defused, not dropped.
- **P0 — a refused correction set was swallowed.** A set applies whole or not
  at all, so one conflicting correction leaves *every* correction unapplied
  while the review queue still shows them accepted. The `.catch(() => undefined)`
  meant nothing said so. There is now an `onDidRefuseCorrections` event and a
  notification, and the session is marked corrected only after the server
  accepts rather than before the await.
- **P1 — a re-derivation was invisible behind the saved snapshot.** `functions()`
  answers from the project snapshot when one exists, and the snapshot is
  refreshed only by a save. After a correction, the Functions pane and
  `delver_reanalyze`'s own before-count both reported the last save's state as
  current. Re-derived sessions now bypass the snapshot for derived facts.
- **P1 — the decompiler cache survived a re-derivation.** Its key covers
  accepted *types*, not bounds, so the pane kept serving a body for a function
  that had just been undefined. It now evicts on `onDidRederiveFacts`.
- **P1 (Rust) — exclusion checked only an instruction's start address.** See
  above; this is the one that most directly broke the feature's headline claim.
- **P1 — a fact-ordered walk could resume across a re-derivation.** The paging
  cursors were written when detected boundaries could not move, and a comment in
  `handleListFunctions` said as much. `delver_reanalyze` and accepted
  corrections falsify it: resuming at index 100 of a table that lost thirty rows
  skipped thirty real functions and reported nothing wrong. The agent service
  now counts re-derivations per image and folds that into the cursor's state
  stamp for functions, listing rows, and cross-references, so the walk is
  refused instead. The stamp is empty at generation zero, so a cursor issued
  before any re-derivation is exactly as valid as it was.
- **P1 — `analysis/openImage` reused the handle `"image-0"` for every open**
  while resetting `generation` to zero, so a cursor from a previous image passed
  the `(image_id, generation)` guard. Latent before; re-open became a real
  operation the moment `data_ranges` could differ between two of them. Handles
  are now stamped per open.
- **P2** — confidence no longer rounds to `1.00`/`0.00`; the findings `status`
  filter is validated before the cursor and refuses a non-string instead of
  coercing it to `all`; the oversize-report message no longer points at a
  file-export route that does not exist.

**Four of the twelve data-range tests were vacuous** and are rewritten. Two
compared a pure function against itself, one asserted a call signature, and one
named a trap it did not pin. The `analyze`-atomicity claim they appeared to
cover is `server-analysis`'s and is still untested; that is stated in the code
rather than papered over.

**Byte and assembly patching remains explicitly excluded**, on ADR 0015's
reasoning: a patch changes the bytes, so facts derived from them are facts about
something the sample no longer is. It needs its own decision.

**The xref export could splice two derivations into one retained table.**
Recorded as latent last round; it was live. `retainXrefs` walks the whole
cross-reference table over as many as 512 round trips and never bound the walk
to a derivation, while the session service pushes accepted corrections *without
awaiting them* — so the window is not narrow. The result is retained as the
answer a `.delverdb` opened without its sample gives to "who references this",
for the life of the project, and it would match no derivation at all.

The walk now reads `generation` off every page and restarts, at most twice, if
it moves; rows from an abandoned pass are discarded rather than merged, and if
the restarts run out the table is saved empty and marked incomplete, which
already reports `partial` rather than a confident zero. The check is on the
*result* rather than on a refusal from the server, deliberately: this is `common`
code reaching the analysis server across IPC, where a structured error kind does
not survive and a refusal would surface as a generic failure that aborts the save
instead of restarting it.

The server-side guard is now reachable too. `analysis/xrefIndex` accepts the
`generation` a caller took its index against, and refusing it was reported as
`ErrorKind::InvalidAddress` — which claims the caller named something never
valid, the opposite of what happened. There is now an `ErrorKind::StaleDerivation`
saying what actually occurred, exercised by a node test against the real server
that also checks the *unguarded* call is still answered, so the guard is
load-bearing rather than decorative.

**Verified:** 409 Delver TypeScript tests, 248 Rust tests, and the 10 Python
decompiler-worker tests pass; the client typecheck is clean, the corpus matches
6/6, `cargo fmt` and clippy are clean, and the layers check is clean. Run the
TypeScript suite with the full selector — `--grep Delver` alone misses six
suites, as the previous session found the hard way.

### Previously — a four-way audit, and partial verification

**A four-way audit over the session's uncommitted work, and the finding that the
verification itself was partial.** Four read-only agents covered the Rust
workspace, the platform layer, the workbench services, and the contribs plus
test quality, each verifying findings against the code before reporting. Every
row is fixed; the pass is written up in [defect-audit.md](defect-audit.md).

**The finding that matters most is about the method.** `scripts\test.bat --grep
Delver` — used for verification throughout the session — **misses six suites**,
because their names do not start with "Delver": `GhidraDecompilerProtocol`,
`GhidraHeadlessDecompiler`, `PyGhidraDecompiler`, `DecompilerWorkerHost`,
`InterpretationLog` and `provider exit escalation`. Three cover files this
session modified, and `GhidraDecompilerProtocol › decodes a canonical accepted
semantic snapshot` had been **red for hours** unseen: the v1→v2 semantic-snapshot
normalization made its assertion stale. Every "N passing" figure recorded here
after that landed was measuring a subset. The correct invocation, which reports
397 passing, is now in
[working-with-ai.md §8](../development/working-with-ai.md) rather than only here,
because a future session will reach for `--grep Delver` for the same reason.

What the audit found, in the order it ranks:

- **`openImage` reported the string-scan cap as the sample's string count.**
  `AnalyzedImage.strings_truncated` existed on the same struct and was not on
  `OpenImageResult`, so a capped image reported exactly `string_count: 200000`
  unqualified — `mshtml.dll` wrong by 81,537. The struct already carries
  `decoding` and `coverage_complete` to qualify the *code* counts.
  `strings_truncated` is now on the wire and set.
- **Three agent handlers read one bound and ignored a second.** `IStringsResult`,
  `IFunctionsResult`, `IGetImportsResult` and `IGetExportsResult` each carry two
  independent signals. Worst case, proven: `delver_search_strings` returned zero
  matches marked **complete** having examined 2 of 70,000 strings, because the
  response bound (`list_truncated`, 65,536) fired while the scanner cap (200,000)
  did not. This is the defect fixed in `handleXrefs` earlier in the session and
  left in its siblings. Fixed in `handleStrings`, `handleListFunctions`,
  `handleImports` and `handleExports`; `delver_lookup_function` now qualifies a
  miss against a bounded list instead of asserting absence.
- **`analysis/setCorrections` invalidated `xrefIndex` cursors the protocol
  documented as stable.** `XrefIndexParams.start` was documented as "the table is
  built once when the image is analysed and never mutated", but `reanalyze`
  replaces the whole `AnalyzedImage` while the handle survives. A walk spanning a
  correction would skip or duplicate rows and end early, and a table retained
  from it answers a later "who references this" with the confident zero
  [ADR 0012](../history/adr/0012-retained-xref-table-in-portable-projects.md) exists to prevent.
  `LoadedImage.generation` now increments on every re-derivation,
  `XrefIndexParams.generation` is optional, and a mismatch is refused naming both
  derivations.
- **`setCorrections` reported unqualified zero counts** — no `decoding` field, so
  on an architecture the decoder does not support the reply read "your correction
  applied and the image has zero functions and zero instructions". Fixed by
  adding `decoding`.
- **Nothing in the workbench refreshed after an accepted correction.** The one op
  whose whole purpose is re-deriving facts was the one op no view watched:
  `isSemanticOp` omitted `FunctionBounds` and no contrib listened for it. A new
  `IDelverSessionService.onDidRederiveFacts`, fired only after the server
  confirms the re-derivation, is consumed by the pseudocode pane and the
  Functions view.
- **Four P2s.** `analysis/scanStrings` had no byte budget while its sibling
  `analysis/strings` has both a count and `STRING_LIST_JSON_BUDGET` — an
  oversized frame kills the analysis server outright. `refresh` was folded into
  the decompile cursor's filter fingerprint, so continuing a walk required
  repeating `refresh: true`, which re-ran Ghidra once per page. `semanticsIgnored`
  was stored in the cache entry rather than applied on the way out, so an entry
  kept warning about accepted types after they were retired. `correctedSessions`
  was never cleared on release. Three misattached or dangling doc comments went
  with them.

Three test-quality defects, which are the same class one level up:

- A `toolCount: DELVER_AGENT_CAPABILITIES.length` assertion **could never fail**,
  because the tool list is built by mapping that same list; it had replaced a
  literal that could. It now pins the set of no-argument tools *and* keeps a
  literal count, verified to fail by forcing a capability onto the fallback
  presentation path.
- A refusal assertion accepted any rejection and compared facts by count only. It
  now names the conflict and compares function identity.
- The pseudocode reload classifier had no test at all despite being wrong twice.
  `isSemanticOp` is exported and covered.

### Previously — a capped string scan no longer hides the tail of a large image

**A capped string scan no longer hides the tail of a large image.** The cap was
written off as unreachable outside a hostile file. It is not. Scanning the 35
largest binaries in a stock `C:\Windows\System32`, **9 hit the 200,000-string
cap** — `mshtml.dll` at 24 MB among them, and a 228 MB `MRT.exe`. `mshtml.dll`
now yields **281,537** strings, 81.5k of which no call could previously reach;
`MRT.exe` yields **5,736,204**, 5.5M of them previously unreachable, over 28
continuations. The measurement is the justification: it is what turned a
theoretical bound into work worth doing.

`find_strings_from` in `delver-analysis/src/strings.rs` is a resumable, bounded
scan, and `find_strings` is now `find_strings_from(..., 0, MAX_STRINGS)`, so
there is one implementation rather than two that could disagree at the cap.
`StringScan` gained `next_rva`. `analysis/scanStrings` serves a bounded window
over the image, capped at `MAX_SCANNED_STRINGS` — a cap on one *response* rather
than on the binary. `delver_list_strings` and `delver_search_strings` walk in two
phases: an index into the list retained when the image was analysed, then a
position in the image once past it. The cursor carries which phase it is in, in a
new optional field, because an offset into a list and an address in an image are
not the same number.

**Offline projects cannot scan and say so.** The retained list is all a project
without its sample has, so the old answer — some strings were never extracted and
no cursor will reach them — is still correct there and is still what it returns.

Four findings from building it that a reader cannot re-derive:

- **ASCII and UTF-16 need separate budgets.** A shared one spent by the ASCII
  pass would leave UTF-16 strings sitting at addresses *below* the cut, which no
  forward cursor could ever recover. Each encoding gets the whole allowance.
- **`next_rva = last.rva + 1` resumes inside the last string** and re-emits its
  tail as a string of its own — `"lpha"@0x1001` after `"alpha"@0x1000` — a string
  that is not in the image at all. Each run start now takes an O(1) look-back at
  the byte (or character pair) before it and declines a run that reaches back
  across the cursor.
- **The cut must not split an address.** Two strings can share an RVA — an ASCII
  run and a UTF-16 run at one place — and cutting between them orphans the second
  permanently, because the cursor resumes one past that address. The cut is
  walked back to an address boundary, or forward when walking back would keep
  nothing, which is also what guarantees every page makes progress.
- **A known limit, deliberately not fixed.** Address-ordered progress holds
  because sorted sections and merged coverage give disjoint ascending chunks. If
  two sections genuinely *overlap* in virtual address — which a hostile file can
  arrange — a later chunk can contain addresses below `next_rva`, and a page walk
  would skip them. The whole-image scan is unaffected. It is a real hole in a
  hostile case; it is recorded in the ledger rather than softened.

`truncated` and `next_rva` are now exactly redundant — `truncated ==
next_rva.is_some()`. `truncated` was kept because the wire protocol and
`AnalyzedImage` consume it.

**The lesson worth carrying forward:** a bound is worth measuring precisely
because the measurement can reverse the decision. This one was assumed
unreachable and left alone for that reason; checking instead of guessing found a
quarter of the largest ordinary system binaries sitting against it, which is the
whole case for the work. The same move — check the assumption against real
binaries — is what killed the entry-point heuristics two sessions ago.

### Previously — function detection can be corrected

**Function detection can now be corrected, and no hand-edit reaches the fact
store.** Every authored edit Delver had was a *decoration* on a derived fact — a
name, a comment, a type. A correction is the first authored thing that
contradicts one. Linear sweep invents a function in data it mistook for code; a
function nothing references and nothing lands on is missed entirely; an analyst
could see both and had no way to say so.

`EditOp.FunctionBounds` records the decision in the append-only log,
image-anchored, as canonical JSON. It cost no new lifecycle: propose, accept,
compensation, revert-by-author, `.delverlog` export and import all key on
`(anchor, op)`, so they reached corrections the day the op existed. The one thing
that needed teaching was the JSONL validator, which admits ops by explicit list
and fails closed on the whole log for one it does not know — without that row the
op was inert.

The facts are **re-derived, not patched**. `analyze_corrected` takes the
corrected seed set and recomputes instructions, function starts, blocks and the
xref table from the image bytes; it and `analyze` are one implementation, so a
corrected image is exactly as reproducible as an uncorrected one.
`FunctionSource::Authored` outranks every derived source, the exception directory
included. A set applies whole or not at all, and `reanalyze` replaces nothing
until the new analysis succeeds, so a refused set leaves the image as it was
rather than emptied. `analysis/setCorrections` re-derives an open image without a
provider round trip and reports the function count before and after — S5's
disclosure requirement in the only terms the server can state it. `derive` in
`server-analysis/src/image.rs` is the single place the analysis and the listing
index are produced together, so a re-analysis cannot serve rows for instructions
that no longer exist. The session service pushes the accepted set during open,
before any caller sees the session, and tracks which sessions have one in effect
so a *withdrawal* is pushed too.

`delver_propose_function` is the agent route: review-only `define`/`undefine`,
validation-atomic, bringing the dispatcher to thirty-five capabilities. A
`define` must land in mapped executable memory. An `undefine` is checked against
nothing on purpose — the address may not be a detected entry by the time a human
reviews it, and refusing it there would stop an analyst pre-empting a seed the
next analysis is about to invent. `undefine` is also narrower than the word
suggests: it withdraws a function start, not the claim that the bytes are code,
so the instructions stay in the index and inbound call xrefs stay in the table.
[ADR 0015](../history/adr/0015-authored-corrections-re-derive-facts.md) records
the decision and the four alternatives that lost.

**The lesson worth carrying forward:** the obvious repair was actively worse than
the bug. Removing a seed does not implement `Undefine` — recursive descent
rediscovers the address the moment anything calls it, and linear sweep re-guesses
it — and making the sweep *skip* an undefined start manufactures a guess: a skip
advances a single byte, so undefining `0x1004` leaves those bytes unvisited and a
fresh `LinearSweep` guess appears at `0x1005`. Withdrawing one function start
would have created a neighbouring one. The refusal has to sit where addresses
*become* functions — `Descent::add_function`, the choke point every discovery
path funnels through — not where they are listed.

### Previously — a long function can be read to the end

**A long function can now be read to the end.** `delver_decompile` used to slice
its text at a byte offset and stop; everything past roughly 157 KB was
unreachable by any call an agent could make, and `lineMappings` still described
every line of the function — inviting a citation of line 4,000 from a caller that
had been shown 900. It now pages on line boundaries with `nextCursor`,
`firstLine`, and `totalLines`, mappings scoped to the lines in front of the
caller, and `variables` on the first page only, since it describes the whole
function rather than any page of it.

The cursor is bound to the exact text it was issued against, not just to the
project revision. Re-decompiling — or accepting a type — produces different lines
under the same numbers, and continuing into that would splice two different
bodies together and present the result as one function. A stale cursor is refused
with `STALE_REVISION` instead. Two guarantees hold the walk together: a page
always emits at least one line even when that single line is over budget, so a
walk can never stall reissuing the same cursor; and a cursor past the end is an
explicit error rather than an empty page that looks like completion.

### Previously — the entry point now says it is not your code

The PE `Subsystem` was not parsed anywhere — it is now, exactly,
and it reaches the wire as a tagged union whose unrecognized case keeps the
number it held rather than collapsing into a named variant. That plus labelling
the image entry as the C runtime stub is real: an analyst is told whether to
expect a `main` or a `WinMain`, and told that the address the header names is
scaffolding.

**The detection half was measured rather than assumed, and it fails.** A
call-graph walk for the MSVC startup shape is written and tested in
`delver-analysis/src/entry_role.rs`; run against 80 real System32 binaries it
resolved **none** of them, declining to the CRT entry every time. Two heuristics
were falsified against actual samples: the startup path is a fan-out, not a
chain of single-call forwarders, so a walk following one call stops at once; and
"the call between `_initterm` and `exit`" is meaningless because address order is
not execution order — on `where.exe` the `exit` call sits below the `_initterm`
call. Newer binaries link the CRT statically and expose no marker imports at all.
The walk is kept, unwired and recorded as incomplete on the P5 roadmap, because it
is correct on the shapes it does recognize and produced no false positive in
those 80 samples.

**The lesson worth carrying forward:** a heuristic is a claim about real binaries
and can only be checked against real binaries. Both rules were plausible, both
survived review, and both died in one afternoon against `System32`. The cost of
measuring was an hour; the cost of not measuring would have been a feature that
confidently mislabels the wrong function as `main`.

### Previously — accepting one type no longer empties the pane

It did, and silently. Headless has no route for declarations, so it refused any request
carrying them; meanwhile the saved pseudocode for every function had been
produced against the empty snapshot and no longer matched the accepted one, so
it was skipped. Saved text rejected, live text refused, nothing left — for the
whole image, discovered one function at a time.

The fix is an attribution, not a special case. A backend that cannot apply
declarations is answering against *no* accepted semantics, so that is the
snapshot its request carries, the snapshot its result is cached under, and the
snapshot the saved result records. Pseudocode saved before any type was accepted
then matches again and is served without starting a backend at all; the cache
stops missing on every call; and configuring a backend that *can* apply
declarations moves the effective snapshot back, which re-decompiles exactly as it
should. The result carries `semanticsIgnored`, so the pane appends "accepted
types not applied" to its provenance and an agent gets `partial` with the reason
spelled out — pseudocode that quietly ignored the analyst's types would be a
confident answer to a question nobody asked.

**The lesson worth carrying forward:** refusing is not automatically the honest
option. [ADR 0013](../history/adr/0013-accepted-semantics-as-decompilation-input.md)
argued that returning type-free text would be dishonest and concluded the backend
should refuse — and the refusal turned one accepted type into total data loss,
which is a worse failure and a quieter one. The honest move was never "answer or
refuse"; it was to attribute the answer to the inputs it was actually produced
with, and say so. The ADR now records both the correction and why the first
reading was wrong.

### Previously — an agent can introduce a structure

**An agent can now introduce a structure, not just name one the program already
carried.** This was the gap blocking S4's exit criterion. The worker's only route
to a data type was `DataTypeParser.parse` over a declaration string, which
resolves type *references* and cannot define one, so an agent could use
`struct _IMAGE_DOS_HEADER` because Ghidra shipped it and could never propose a
layout it worked out from the code. The analyst was capped the same way: a struct
recovered by hand had nowhere to live but a comment.

`Anchor` is now `IImageAnchor | ITypeAnchor`, where a type anchor is
`{ kind: 'type', contentHash, name }`, and `EditOp.CompositeType` records one
named layout as canonical JSON — kind, size, and fields at explicit offsets, not
a C declaration string. A composite is the first authored thing with no location.
**Invariant 4 is intact**: a type anchor is still scoped to `contentHash` and
still carries nothing relocation can move; what widened is only the claim that an
anchor names a *place*. `anchorKey` puts the kind in the key —
`<hash>:type:<name>` beside `<hash>:rva:<hex>` — so a name can never share a slot
with an address that renders the same way, and `isImageAnchor` / `isTypeAnchor`
exist so every new consumer has to choose deliberately, with the compiler asking.
[ADR 0014](../history/adr/0014-type-anchors-for-authored-composites.md) records
the decision and the three alternatives that lost.

The composite reuses the entire edit log unchanged. Propose and accept through
Review, undo by compensation, per-author revert, `.delverlog` export and import
all reached composites the day the op existed, because that machinery keys on
`(anchor, op)` and never on an address. `.delverdb` needed no migration either:
`interpretations` stores each edit as an opaque payload, and the schema stayed at
v8.

The semantic snapshot is now `schemaVersion: 2`
([ADR 0013](../history/adr/0013-accepted-semantics-as-decompilation-input.md),
amended). Its `composites` array is applied **before** `dataTypes` and
`functionPrototypes`, so a declaration can name a struct the same snapshot
introduced. Both decoders — TypeScript `readSemanticDependencies` and the
worker's `required_semantics` — accept v1 and v2 and normalize a v1 payload up to
v2, because a v1 snapshot *is* a v2 one with no composites; that normalization is
what stops pseudocode saved before composites existed from comparing as stale. A
v1 payload that carries composites is refused all the same, since that sender is
confused about its own shape.

PyGhidra defines the structures in two passes — register every name as an empty
`StructureDataType` with packing disabled, then populate fields at the offsets
they were authored with — so a field typed `struct Other *` resolves whichever
direction the reference runs, and mutually referencing structs both land. Packing
stays off because padding in a real binary is something the analyst measured, not
a flaw to tidy up. All of it still happens inside the transaction that is
unconditionally rolled back, so the persistent content-hash project is untouched.

`delver_propose_type` accepts `target: "composite"` with `name`, `size`, and
`fields` in place of `address` and `declaration`. The tool schema is a `oneOf`
rather than one object with optional fields, so a composite cannot be sent with an
address that would be silently ignored.

**Two defects were fixed on the way through.** `IDelverFindingEvidence` declared
`anchor: Anchor` while its own wire type had always required `kind: 'image'` — the
domain type was the loose one, and the two disagreed for as long as both existed.
Findings are now permanently `IImageAnchor`, by decision rather than by accident:
a finding is a claim about bytes, and there is nothing to cite in a range with no
address. And `validateEdit` in the JSONL store
(`platform/delver/node/delverInterpretationStoreService.ts`) still required
`kind === 'image'` and listed only the five original ops, so a composite could not
survive `.delverlog` append, export, or import at all. It now validates each
anchor kind on its own terms and checks the *pairing* too: a `compositeType` at an
address and a rename on a type are both refused, because the snapshot builder
looks only at type anchors, so a looser validator would accept an edit nothing
would ever read.

**The lesson worth carrying forward:** a union of one is not a union. A
discriminated union with a single member cannot be narrowed wrongly, so every
claim resting on it is unverified until the second case arrives — which is why a
domain type saying `Anchor` while its wire form said `image` sat there disagreeing
with itself, uncaught, for as long as both existed. Widening the union is what ran
the check for the first time.

### Previously — accepting a type changes the C on screen

**Accepting a type now changes the C on screen.** The pseudocode pane
re-decompiles when an accepted `DataType` or `FunctionPrototype` edit lands for
the bytes it is showing. Its interpretation handler previously did one thing —
re-render comment decorations — which is right for names, comments and tags,
because those decorate C that is still correct, and wrong for types, which change
the C itself. Until now the pane kept showing output produced against the
superseded type model, and nothing in it said so.

The reload is an ordinary request rather than a `refresh`. The cache is keyed on
the semantic snapshot, so the new snapshot misses on its own, the old entry stays
valid for whoever still wants it, and saved pseudocode that legitimately matches
the new snapshot is still reused. A `proposed` edit deliberately does not trigger
it: only accepted edits are in the snapshot, so re-decompiling on a proposal would
spend a backend round trip to arrive at the same text. Failure is swallowed by
design — the analyst accepted a type, they did not ask for a decompilation, so a
backend that is down leaves the previous text alone instead of replacing it with
an error.

Three smaller things were fixed on the way through. The snapshot is folded to a
digest in the cache key rather than spelled out — inlining it put a copy of every
accepted declaration into all 128 keys and re-serialized the whole set on the hot
path of every pseudocode load. An empty snapshot is no longer written into saved
results, because the decoder already reads an absent one as empty and a project
with no authored types is the common case. And a snapshot past the worker's bound
of 10,000 declarations per kind is now refused *before* the request is built,
rather than by the worker after 20 MB has crossed the pipe: refused rather than
truncated, since a decompilation against some of the analyst's accepted types
would present as though all of them applied.

Both load-bearing decisions behind this — that accepted interpretation is an
input to one decompilation rather than a mutation of the backend's own state, and
that the snapshot is part of decompilation identity — are recorded in
[ADR 0013](../history/adr/0013-accepted-semantics-as-decompilation-input.md).

**The lesson worth carrying forward:** an authored edit is either an *input* to
the decompiler or an *overlay* on its output, and one subscription cannot serve
both. Everything the interpretation layer carried until this slice was an overlay,
so the single handler was correct right up to the moment it wasn't — and it failed
in this project's most dangerous direction, showing plausible C for a type model
the analyst had already replaced.

### Previously — accepted types reach PyGhidra

**Accepted S4 types now reach PyGhidra without letting stale pseudocode survive.**
Every decompilation carries the complete accepted data-type/function-prototype
snapshot that produced it. The snapshot is embedded in portable saved results
and in the bounded memory-cache key, so acceptance, clearing, undo, and replay
cannot reuse output produced against different semantics.

PyGhidra validates and applies that snapshot inside a rollback transaction:
global data declarations are restricted to mapped non-executable memory, and
function prototypes are applied only to exact entries before decompilation.
Rolling the transaction back keeps the persistent content-hash project clean,
so revising or clearing an authored declaration is deterministic. The legacy
headless backend declares that it cannot apply accepted semantics, and is
answered against the empty snapshot with the result marked `semanticsIgnored`
rather than refused.

Invalidation is correct but intentionally conservative: the first durable
schema records the whole content-wide semantic snapshot, so any accepted type
change invalidates every saved function for those bytes. The next refinement is
to retain the exact globals and callees each function consumed and narrow the
stamp without changing its versioned envelope.

### Previously — semantic proposals

`delver_propose_type` adds validation-atomic, review-only data types and exact-
entry function prototypes to the append-only interpretation log. Accepted
values materialize independently and survive replay and reopen.

### Previously — observed globals

`delver_list_globals` inventories non-executable addresses actually named by
retained data references, while `delver_global_accesses` returns the referencing
instructions and containing functions. They remain intentionally partial
observations, not recovered declarations: no size, type, read/write mode,
register-derived pointer, or runtime-only access is inferred.

### Previously — retained cross-references

**A portable project now retains its cross-reference table, so an offline
`.delverdb` can answer who references an address.** This was the top item on the
plan's result-loss list, and the reason it was worth paying before anything in
S4: every revision saved without a retained table stays permanently unanswerable
for the one question most analysis turns on.

The shape is recorded in
[ADR 0012](../history/adr/0012-retained-xref-table-in-portable-projects.md). The
decision that mattered was **table, not blob**. The five existing analysis
payloads are opaque JSON in `analysis_snapshots`, and a sixth would have been the
cheapest thing to write — but a real module has millions of references, so that
blob is tens of megabytes read into memory on every open, and any bound applied
to keep it tractable becomes a silent false negative. So: a real indexed
`xrefs` table, queried by address, never read whole. Schema **7 → 8**, forward
only, no downgrade path.

- **The wire.** A new paged `analysis/xrefIndex` exports the whole table from
  the analysis server. The cursor is a plain index into the table's own source
  ordering, which is stable because the table is built once when the image is
  analysed and never mutated. `next_start` is absent exactly when the walk is
  complete — a caller must be able to tell "the table ended" from "this page was
  bounded", so the absence is the signal and nothing normalises it to a number.
- **The storage.** Addresses are stored as sixteen zero-padded hex digits.
  Variable-width hex does not compare numerically as `TEXT` — `"0x9000"` sorts
  after `"0x1ffffffffffffff"` — and an `INTEGER` column was not an option,
  because SQLite hands the value back as a double and truncates it above 2⁵³,
  which is invariant 2 exactly. Padded `TEXT` is both sortable and still a valid
  wire address.
- **The refusal.** A project that retained no table still answers
  `TARGET_NOT_ATTACHED`. A table exported only partly always answers `partial`,
  never `complete`. Both cases exist so that "no references" is never returned
  as a fact the caller can act on when it is really a gap in the project.

**Listing rows are still not retained, deliberately.** They are an order of
magnitude larger than the xref table and the decision is left open;
`delver_disassemble` and the other byte-decoding tools still require the sample.

**A P0-class defect in the same handler, found while extending it.**
`handleXrefs` was reporting the *returned slice's* length as `total` and calling
the result `complete` once a caller paged to the end of it — even when the
analysis server had capped the reference list at 4,096. For any hot address, an
agent was told there are exactly 4,096 references and that the answer was whole.
That is a confident false claim about the sample, which this project's own
ranking puts above a crash. It now reports the server's true pre-cap `total`,
exposes `sourceBounded`, and marks the result `partial`. The convention it should
have followed was already sitting in `handleStrings`, which has kept the scan cap
and the page boundary apart as two different truncations since it was written.

**The lesson worth carrying forward:** every truncation is a claim, and the
dangerous ones are the bounds a caller cannot see. Three now meet in this one
handler — the page boundary, the server's per-address cap, and a partly exported
retained table — and only the first is fixable by asking again. The code names
which one fired, because "partial" without a reason sends a caller back around a
loop that cannot terminate.

### Previously — the defect audit reached empty

**The defect audit is empty.** Every row of
[defect-audit.md](defect-audit.md) is fixed. This session re-verified the
thirteen rows the 2026-08-27 pass had left listed and found eleven of them
already closed in the tree — the work had landed, the rows had not been deleted.
Two were genuinely open, and both are now fixed:

- **`RESULT_LIMIT_EXCEEDED` could fire after a write had committed.** The
  dispatcher measured the serialized envelope and threw if it was over budget,
  which for a write means telling an agent that proposals or findings already
  appended to an append-only log did not happen — and an agent's correct response
  to a failed write is to make it again. `delver_report_finding` echoes 50
  titles, descriptions and evidence texts against a 256 KB budget, so a
  20-finding batch at the per-finding character bound cleared the limit on its
  own. Write handlers now supply a `reducedData` payload holding only the record
  identities the caller cannot reconstruct; an oversized write result is reduced,
  marked `partial`, and says so. This follows the precedent already sitting one
  statement below it, where retention failure after a commit returns the result
  with a provenance note rather than throwing.
- **`delver-mcp` flattened every non-tool failure to `"Internal error"`.** The
  `tool_error` arms preserved the message; the catch-all discarded it. `tools/list`
  is dispatched with `tool_error: false`, so a root matching no published window —
  the one failure a caller can actually fix — arrived as an internal fault. Every
  `BackendError` message is written to be safe to return, so the message now
  survives whichever arm the failure takes, and an `InvalidParams` kind maps to
  `INVALID_PARAMS` regardless of which method produced it.

**The lesson from this session is about the list, not the code.** A defect list
that outlives its fixes costs the next reader exactly the re-verification the
list existed to save. Deleting the row is part of the fix, and the audit now says
so in its own header.

`npm run delver:protocol` has since been run — `protocol.generated.ts` declares
`epoch: string` and carries the new completeness fields, so step 1 of the
verification sequence is done. Steps 2 and 3 are not.

### Previously — the 2026-08-27 defect-audit fix pass

Every row except #30 was fixed — 3 P0, 13 P1 and 19 P2 —
across the Rust workspace, the platform and service layers, eleven view
contributions and the agent-bridge extension. Eleven agents worked in parallel on
disjoint file sets; each verified its rows against the code before changing
anything, and four rows turned out to name the wrong cause or the wrong size (the
audit now records which, and why).

**Both passes are now verified.** The binaries were rebuilt and everything ran
green — 195 Rust tests, 318 Delver TypeScript tests, a clean client typecheck,
and 6 matching corpus samples. The first green run cost two fixes of its own, in
the audit's Verification state.

Three changes are larger than a defect fix and are recorded as decisions:

- **`.delverdb` schema 6 → 7.** Named signatures are now an append-only,
  authored record log ([ADR 0011](../history/adr/0011-append-only-named-signatures.md)).
  In-place `UPDATE`/`DELETE` was destroying the prior pattern, proof and
  `sourceCallId` — exactly what `cross-revision-stable` reads as evidence, so
  renaming a signature silently corrupted the basis for matching later revisions.
  Forward migration is automatic; **there is no downgrade path.**
- **The function fingerprint changed.** Two implementations of "where does the
  last function end" were unified onto the tested one, which changes the digest of
  the last function in every image. Normalization is bumped
  `delver-server-listing-v2` → `v3`, so stored v2 fingerprints match nothing —
  the fail-safe direction, as with the `Indirect` split.
- **The unsafe-code posture is now described accurately.**
  [ADR 0010](../history/adr/0010-unsafe-code-in-os-security-modules.md) supersedes
  0003, which claimed one module was "the only module permitted to use `unsafe`"
  while two others already did.

**The lesson worth carrying forward:** the highest-value defects were not crashes.
They were *confident false claims about the sample* — a malformed import table
reported as "no imports", a TLS directory failure reported as "no TLS" (where
callbacks run before the entry point), an ARM64 PE reported as zero instructions,
a page size reported as an image total, and a user's own cancellation reported to
an agent as `INTERNAL_ERROR`, a code it is entitled to retry. Every one of them
reads as a successful answer. That is why the audit ranks a wrong answer above a
crash, and the ranking held up under the fix pass.

A second, narrower lesson: `instanceof` on an error that crossed the
shared-process boundary is always wrong here — the channel rebuilds rejections
from `{message, name, stack}` and the prototype is gone. It was wrong in four
places, in three files, written by different hands.

## Previously — workspace redesign

The workspace redesign is structurally complete. Delver's eleven analysis
surfaces no longer live as `ViewPane`s in one sidebar container; they are
segments of a three-zone workspace editor, one editor per target. Navigator
answers *what exists in this binary*, Primary *what am I reading*, Inspector
*what does the cursor touch*. Each zone is an independent column with its own
scroll, so no surface can shrink another — the property the container could not
provide, and the reason opening any pane used to resize every other one.

The sidebar container survives with a single view, a target launcher listing
open and recent targets. It exists only because an activity-bar entry *is* a
view container upstream; keeping the icon without one would mean patching
`activitybarPart.ts`. Its one view earns its place rather than being a stub.

Actions no longer bind to containers. `delverSelectionKind` and
`delverSelectionAddress` carry what is selected, and object-scoped actions
contribute to one `MenuDelverSelectionContext` — so "Generate Signature" cannot
appear while a section is selected, because it is not an action on sections.
Four dead `MenuId.ViewTitle` contributions are gone. A zone header now carries
only view state: pin, per `principles.md` §5.

**The lesson worth carrying forward:** every serious defect found in this work
had one shape — *a gate that assumed a single host*, failing silently. Actions
resolved the listing with `instanceof DelverListingEditor`. `LISTING_ACTIVE`
compared the active editor's id, which disabled every listing action inside the
workspace. A zone bound context off its selected segments without asking whether
it was visible, so hidden workspaces issued analysis requests and rewrote each
other's persisted state. None produced a type error.

**Launched and smoke-tested.** Zones render as independent full-height columns
carrying all eleven surfaces; the listing renders real disassembly inside a
zone; Primary splits Listing | Pseudocode; pin appears in the zone chrome. No
Delver console errors.

**Three defects the launch found**, recorded in
[workspace-plan.md](workspace-plan.md):

1. **Cross-target contamination, and it needs an ADR.** Two open workspaces show
   the same data: the workspace is per-target, but `IDelverSessionService`
   has a single `activeSession`, so every surface reading it answers for
   whichever target was opened last. This mismatch predates the redesign; the
   redesign made it reachable. Do not paper over it by serialising opens.
2. **Four of five Navigator surfaces render no rows** — Functions, Imports,
   Exports, Sections. Strings works because it resolves lazily in
   `getChildren`; the others refresh from `onDidChangeActiveSession`. Reproduced
   with one target open, so it is not caused by (1).
3. **Navigator segment labels truncate** to `Fu... S... I... E... S...` at 240px, two of
   them indistinguishable. Segments only pay for themselves if they are legible.

### Earlier this phase

The first defect-audit repair pass is verified. File-provider image reads now
clamp attacker-controlled section offsets to the real mmap; dense analysis state
is bounded by actual file-backed bytes and by one aggregate file-sized budget;
and only real iced `NearBranch*` operands can produce a direct target, so
`syscall`, `sysenter`, and far calls no longer manufacture a function and call
xref at RVA 0. Five session-driven sidebar views clear another target's rows
when their replacement refresh fails. Review actions resolve invocation-scoped
services before awaiting, signature policies render exhaustively, bounded
revision scans name what they omitted, and byte-search results are discarded
after a target switch. The audit rows have been moved to its fixed section.

The previously locked native binaries were restaged after closing the old
workbench. Verification is clean: 154 Rust workspace tests, 15 live
`DelverAnalysisSession` integration tests (including the generated PE import
directory and both IAT-resolution paths), and 246 Delver TypeScript tests pass;
client typechecking and fresh transpilation are clean.

S3 reaches its exit criterion. `delver_call_paths` traces a source-to-sink path
and returns the complete ordered address evidence — every step carries the exact
calling instruction, because a path of function names an analyst cannot go and
look at is not evidence. The sink may be a function entry *or* an IAT slot,
which is the form the question actually takes on a sample: "what reaches
`VirtualAlloc`?" The search is a breadth-first walk over partial paths, each
carrying its own visited set, so recursion terminates while two genuinely
distinct routes through the same function both survive. Edges are derived when a
frontier is popped, never precomputed — the plan's requirement that this work
without materializing the program graph.

Its real subject is the negative answer. An empty path list is a claim about the
program only when the search was exhausted, no depth or visit limit fired, no
path was truncated, and no unresolved indirect call site sat on the frontier —
`CallPaths::proves_absence()` is that condition, executable rather than
described. Anything less is `partial`, with the specific cause named. A call
through a register or a vtable is exactly where a real sample hides the edge
being looked for, so a bounded search that reported "no path" as proof of
absence would clear code that should have been flagged.

The call graph can now name the calls that matter most. On a Windows binary the
most common outgoing call is a call to an imported API, and it goes through the
IAT — so it used to show up as an unnameable indirect site. It is now resolved
from facts already retained: a `call [rip+X]` emits a data reference to the slot
its memory operand names, and the import table names exactly one symbol for that
slot. A direct call landing on a one-instruction `jmp [IAT]` import thunk
resolves the same way, one hop and no chains. Both report `method`
(`iatOperand` or `importThunk`) and `confidence` (`exact`); `probable` exists
in the enum for future vtable and dataflow resolutions so a weaker method cannot
arrive disguised as an exact one. Ambiguity fails closed everywhere — two data
references from one site, a slot no import claims, or a slot two modules claim
all stay unresolved rather than guessing a symbol.

That changed the completeness rule, and the change matters more than the
feature. `delver_call_graph` used to report `partial` whenever a function
contained any indirect call site, which on real binaries is nearly always — a
flag that fires every time is a flag a model learns to ignore. It now reports
`partial` only when a site remains *unresolved*, so a function whose every
outgoing call is named can finally say so, and a partial result is a real
warning. [`ai-analyst.md`](../architecture/ai-analyst.md) §2.1 records the rule
and the derived-fact vocabulary.

S3 program structure now answers "how big is this and who talks to it?" in two
calls instead of hundreds. `delver_function_profile` sizes one detected
function — instruction, block, edge, call-site, and return counts — so a model
can judge a function before reading it. `delver_call_graph` returns its bounded
direct callers and callees, each cited function-relatively the way xrefs are,
and pages callers and callees as one concatenated sequence so a cursor cannot
skip or repeat a row at the boundary. Both derive from facts the analysis
already retains: the bidirectional xref table, the detected function bounds,
and the instruction-flow records added for basic blocks. Neither decodes again.

The call graph refuses to let a direct answer read as a complete one. Call
sites whose target is not statically known are returned as evidence rather
than dropped, and their presence alone forces `partial` — a model that reads an
untruncated first page as "these are all the functions this one calls" is wrong
in exactly the cases that matter. Paging, the server's own bound, and an
unresolvable call site are reported as three distinct reasons, because only the
first is fixable by asking again.

Two facts the analysis had been eliding were separated to make that claim
honest. `FlowKind::Indirect` conflated an indirect call with an indirect branch,
so a jump-table dispatch counted as an unnameable call; it is now
`IndirectCall` and `IndirectBranch`. Splitting it also fixed a decoding gap —
an indirect call *does* return to the following instruction, and the conflated
variant stopped recursive descent there. Both fingerprint normalizations are
bumped to v2 accordingly; a stored v1 fingerprint no longer matches anything,
which is the fail-safe direction. `terminates_block` was corrected to agree
with `falls_through` about an indirect call, so the corpus snapshot and
`control_flow::basic_blocks` cannot cut the same function into different
blocks.

A function with no recorded end and no following function — the last function
in every PE, because the entry-point seed carries no end — previously had no
extent at all, so every structure request refused it. The extent now falls back
to the end of the contiguous decoded-instruction run from the entry, stopping
at the first gap. `bounded` continues to mean *recorded*, not *inferred*, and a
profile over an inferred extent reports `partial` and says every count below it
is an estimate of size rather than a measurement.

S3 now has its first provider-derived program-structure slice.
`delver_basic_blocks` resolves one detected function by containing address or
exact name and returns bounded half-open blocks plus typed fallthrough, jump,
and conditional-taken edges. Native analysis retains exact instruction-flow
facts, splits blocks across undecoded gaps, restricts truncated edges to the
returned block set, and labels bounded graphs partial instead of presenting
them as complete control-flow proof.

S2 instruction search is live. `delver_search_instructions` performs exact
case-insensitive mnemonic matching with an optional case-insensitive substring
over the displayed operand text. Pagination is revision- and query-bound,
retains the held-back match, and complete negative results require scanning the
remaining decoded instruction list. It deliberately does not claim structured
immediate or constant semantics.

The **Review** tree now supports group-level **Accept All** and **Reject All**
actions for interpretation proposals and findings. Each action snapshots the
currently pending ids and submits one existing validation-atomic domain batch;
proposal resolutions and finding decisions remain separate append-only models,
and untitled projects enter the normal dirty/Save lifecycle.

**Generate Signature...** now starts with an explicit policy choice:
relocation-stable remains the recommended first item, cross-revision-stable
uses retained earlier-revision proof, and unique-now keeps every current byte
exact. A successful cross-revision result shows its contributing revision count
and names alongside the IDA-style pattern before copy or save. The presentation
parser fails closed unless the policy is recognized, the revision count is
consistent, and every retained proof contains the exact generated primary
pattern. Earlier Revision Scan skips that prompt and requests
cross-revision-stable generation bound to the exact selected revision and saved
signature ids.

`delver_make_signature` now implements a conservative first
`cross-revision-stable` policy without trusting or reopening historical source
paths. It requires an exact, uniquely proven primary signature for the same
function identity in at least one earlier project revision, regenerates the
current candidate with relocation-aware masking, and accepts it only when the
identical masked pattern is still an exact unique match at the current function
entry. Results expose the contributing revision, signature, and source-call ids
as a separate proof chain; missing, conflicting, changed, or currently ambiguous
evidence fails closed with `ANALYSIS_INCOMPLETE`. Proven results can be named and
persisted with their `cross-revision-stable` policy in schema-v6 projects.
Optional paired `sourceRevisionId` and `sourceSignatureId` inputs bypass name
heuristics and bind the proof to one exact retained signature; selectors are
rejected for other policies or when only one is supplied.

The **Signatures** title bar now exposes **Export IDAPython Matchers...** for
live and offline project revisions. It writes one deterministic `.py` bundle
containing every saved primary signature, sorted by name. Each entry is checked
independently with the same exact-uniqueness, function-entry, and name-conflict
guards as the single matcher, and the script finishes with applied, already
named, preserved, missing, ambiguous, non-function, and rejected totals.
Xref-site alternatives are excluded because their pattern identifies a caller,
not the function entry that should receive the saved name.

Saved primary signatures now offer **Copy IDAPython Matcher** from their context
menu. The generated script uses IDA's current `find_bytes` API, scans the whole
IDB, proves there is exactly one match, requires that address to be an existing
function entry, and only replaces a dummy name. It preserves different authored
or otherwise non-trivial IDA names, jumps to a successful match, and reports
missing, ambiguous, non-function, or rejected-name outcomes without forcing a
mutation. Xref-site alternatives do not expose the action because their match
address is a call site rather than the identified function entry.

Accepting a regenerated unique primary result from **Earlier Revision Scan** now
persists a `signature` function-revision mapping with both retained search and
generation call ids. Delver revalidates the complete one-match search proof at
the project boundary, then transfers the older function's authored name,
comment, and tags. Missing target fields are accepted append-only imports;
different current values are preserved and emitted as proposals in **Review**.
Repeating the operation is idempotent for interpretation state and does not
duplicate an unresolved conflict proposal.

An exact primary match in **Earlier Revision Scan** can now be regenerated for
the current revision from its row context menu. Delver passes the matched RVA,
historical name, source revision id, and saved signature id into the canonical
cross-revision generator, then requires the identical masked pattern to prove
exactly one current-revision function-entry match before it can be saved. The
project boundary revalidates that exact binding before transferring annotations.
Ambiguous, missing, incomplete, and xref-site scan results never offer promotion
because they do not safely identify a current function entry.

The **Signatures** view can now scan saved patterns from earlier project
revisions against the attached current target. The cancellable scan is bounded
to 100 saved records, deduplicates identical pattern/scope searches, and asks
for only enough matches to distinguish an exact unique relocation from an
ambiguous one. Results remain visible as explicit `unique`, `ambiguous`,
`missing`, or `incomplete` evidence; unique and candidate matches navigate to
the listing. A one-match result proves relocation into this revision only and
is deliberately not presented as universal cross-revision stability.

Saved signatures can now be renamed or permanently deleted from their row
context menu. Renames preserve the signature's stable id and proof, reject
case-insensitive name conflicts, and update the SQLite record atomically;
deletion is revision-scoped, requires explicit confirmation, and refreshes the
view immediately for both untitled and named projects.

Saved signatures now expand into their retained evidence directly in the
**Signatures** view: the copyable IDA-style pattern, source function, generation
strategy, covered RVA range, exact uniqueness proof, quality score, and each
wildcarded operand with its relocation reason. Function, coverage, and wildcard
rows navigate back to the listing, so the durable claim can be inspected without
opening another surface.

The Delver sidebar now includes a **Signatures** view. Its leading search action
accepts IDA-style full-byte and nibble wildcard patterns, pages canonical
`delver_search_bytes` results, and opens each section-qualified match in the
listing. Durable named signatures appear in the same view and can be searched
against the attached image with one click; saves refresh the group immediately.
The view also exposes the listing's **Generate Signature...** action when a
function instruction is selected, keeping generation, reuse, and navigation in
one evidence-focused surface.

The listing editor now exposes **Generate Signature...** for the function under
the selected instruction. It selects exact-current, relocation-stable, or
retained-proof cross-revision policy over executable sections, shows the proven
primary and xref-site alternatives as uppercase IDA-style byte patterns, and
lets a human copy either pattern or save an exactly unique variant as named
project evidence. Generation is cancellable, ambiguous patterns remain copyable
but cannot be mislabeled as saved proof, and empty native signature-mask metadata
is serialized explicitly so stable instructions are distinguishable from an
outdated analysis backend.

Named signatures are now durable project evidence. `delver_save_signature`
accepts only a retained `delver_make_signature` call from the current target
revision and only a primary or xref-site variant with an exact one-match proof;
callers cannot inject an arbitrary pattern and label it proven. Names are
case-insensitive, replacement preserves a stable id, and schema v6 stores the
compact pattern, function/RVA, wildcard derivation, proof, quality, and source
call id per revision. `delver_list_signatures` pages and filters those records
from either a live target or an offline `.delverdb`. Schema v1-v5 projects
migrate forward with an empty signature table and retain all earlier evidence.

S2 now includes an instruction-aware SigMaker vertical slice.
`delver_make_signature` accepts an address or exact function name, grows a
candidate only at decoded instruction boundaries, and proves its match count in
the target function, all executable sections, or the raw-backed image. The
`relocation-stable` policy masks direct branch immediates, RIP/EIP-relative
memory displacements, and PE base-relocation fields from exact decoder/server
metadata and explains every wildcard. Results include covered instructions and
RVAs, match evidence, a deterministic quality score, and a separately proven
xref-site signature when the function bytes remain ambiguous. The conservative
`cross-revision-stable` policy additionally requires the identical
relocation-masked pattern to have retained exact uniqueness proofs for the same
function identity in earlier project revisions and to remain uniquely matched
in the current revision. It does not claim stability across revisions that lack
saved proof, and it never follows untrusted historical source paths.

S2 byte-pattern search is live. `delver_search_bytes` scans raw-backed image
section bytes for one-to-256-byte hexadecimal patterns with full-byte and
nibble wildcards. Optional exact section-name and executable-only filters are
bound into its revision cursor. Reads overlap by `patternLength - 1`, so matches
crossing a 64 KiB provider chunk and overlapping matches are not lost. A page
stops only after proving another match exists; continuing resumes at that match.
A complete zero-match result means every selected candidate position was read,
while a short provider read fails with `ANALYSIS_INCOMPLETE` instead of making a
false negative claim.

S2 now has canonical address conversion. `delver_convert_address` translates an
RVA, absolute VA, or raw file offset into the other spaces using the persisted
image base and PE section table, so it also works when a project is open without
its sample. Results identify the section and its exact half-open virtual/raw
ranges. A virtual zero-fill tail remains a valid RVA/VA with `fileBacked: false`;
headers, gaps, and values below the image base return `ADDRESS_NOT_MAPPED` rather
than inventing a correspondence.

The first S2 raw-evidence capability, `delver_read_bytes`, reads a bounded
range from image RVA or raw file-offset space through the provider's existing
binary-frame protocol. The shared-process boundary carries verified lowercase
hex rather than `Buffer` or `bigint`, while the dispatcher can additionally
decode exact `u8`, `u16le`, `u32le`, or `u64le` values as hexadecimal strings.
Provider-backed ranges, target moment, missing bytes, partial reads, and
image-range provenance remain explicit. The capability requires an attached
sample and is generated into both the built-in chat and MCP tool surfaces from
the canonical catalog.

Opening a named `.delverdb` now reuses its existing per-revision `sourcePath` to
attach the target automatically when the normalized absolute path is inside the
current workspace. The live provider's SHA-256 must match the selected project
revision before the attachment is published. Outside-workspace, missing, changed,
and path-traversal candidates leave the project offline and preserve the manual
**Locate Target...** recovery path; no sample bytes were added to schema v6.

P3c step 3 now has a direct tool-result evidence slice. Every successful
project-bound dispatcher exchange is retained per target revision with its
bounded exact request/result JSON, caller, capability, call id, and timings.
`delver_report_finding` accepts prior `sourceCallIds` on each range and rejects
dangling or cross-target references before retaining any finding. Review expands
those ranges into their cited capability/call rows; selecting a call opens a
read-only JSON evidence document with its identity, caller, timings, and complete
retained request/result. Portable-project schema v6
adds the `tool_calls` table and migrates v1-v4 projects in place; untitled
projects become dirty as soon as a project-bound exchange becomes authored
investigation state.

P3c steps 4 and 5 now have a first complete vertical slice. A **Review** tree in
the Delver activity-bar container combines pending interpretation proposals and
findings. Each row has human Accept/Reject actions; proposal rows navigate to
their anchor, and expanded finding evidence rows publish their exact half-open
image range through the focus bus. Interpretation decisions remain `resolves`
appends. Finding decisions are likewise separate append-only, human-authored
records, serialized per target revision in portable-project schema v6. The
project service validates a complete decision batch before retention, serializes
concurrent reviews per content hash, and fails closed on repeated decisions.

P3c step 2 now exposes four agent writes through the canonical dispatcher:
`delver_propose_rename`, `delver_propose_comment`, `delver_propose_tag`, and
`delver_report_finding`. Each accepts a bounded batch, validates the complete
batch before retention, requires model attribution, and writes only provisional
state. The interpretation tools append `proposed` edits; the finding tool appends
dedicated findings with severity, confidence, described image ranges, model
authorship, and reporting-call provenance. Both work on offline projects because
their anchors use content identity rather than live bytes. Named projects persist
findings immediately in SQLite schema v6, while untitled projects enter the
existing dirty/Save lifecycle. Once a write begins, the bounded batch completes
so dispatcher cancellation cannot conceal a successful prefix. The generated
chat/DTP/MCP catalog now contains twenty-three tools; MCP marks these writes
non-read-only, non-destructive, and non-idempotent.

P3c step 1 is done: proposed and rejected interpretation is a complete state
rather than an enum nothing could leave. A review decision is an ordinary
append carrying `resolves`, so invariant 5 holds — nothing mutates, and a
proposal is pending exactly while no later append decides it. Accepting copies
the proposal's anchor, op, and value under the *reviewer's* authorship, with the
model's proposal still readable one `resolves` hop away; rejecting records what
was declined and leaves the picture untouched. `resolves` is deliberately not
`compensates`: undoing an effect the picture had and declining one it never had
read identically if they share a field, and the review surface has to tell them
apart. [ADR 0006](../history/adr/0006-proposal-resolution-in-the-edit-log.md)
records the decision and the two alternatives that lost.

`propose`, `pendingProposals`, and `resolveProposals` are on the interpretation
service. Batch review builds every resolution against the pre-batch log before
appending anything, so an invalid mixed batch writes nothing. Valid decisions
remain independent append-only records, and an I/O failure may commit a prefix.
Appending a resolution fails closed
on an unknown, non-proposed, or already-decided sequence; replaying a stored log
stays tolerant of the same references, because a log naming a sequence it does
not contain is still the user's work. The field round-trips through the JSONL
record and is resequenced along with `compensates` on import.

P3b's integration assets are published. `Docs/development/external-agents.md` is
the client-facing surface: the generic stdio `.mcp.json`, the staged adapter
paths for development and packaged builds, per-client arrangements for Claude
Code, Codex, Cursor, Kimi, Delver's own workbench, and a minimal reference
client, the lazy discovery/approval sequence, and a troubleshooting table keyed
to the adapter's real error strings. It states plainly that none of those clients
has been through the conformance run yet, so the recipes are not mistaken for
verified ones.

A **Copy External Agent (MCP) Configuration** command now generates that recipe
rather than asking a human to transcribe two absolute paths. It resolves the
staged `delver-mcp` binary through the same Delver-owned candidate scheme the
relay uses — never a `PATH` fallback — and takes the root from the window's own
selection. Its eligibility check *is* activation's: `describeBridgeEligibility`
returns the single reason a window cannot publish, and
`isWorkspaceSelectionEligibleForBridge` is now derived from it. Two gates that
could disagree would produce the worst outcome available here — a copied
configuration for a window whose bridge is permanently inert — so there is only
one. Untrusted, remote, untitled, zero-root, multi-root, non-local, unsupported-
platform, and unstaged-adapter cases each yield their own localized sentence
instead of a generic failure.

P3a's contract and direct vertical slice exist. `IDelverAgentService` is the
single place an agent capability is implemented: the built-in chat tools call
it now, and the P3b command gateway, MCP adapter, and Python client will call
the same `invoke`. Adapters translate protocol and nothing else — the moment
one of them resolves a function boundary for itself there are two analysis
implementations that disagree, and the disagreement surfaces as a model citing
an address no pane ever showed.

Thirty-four capabilities are live: session info, capability discovery,
current context, focus, image info, function listing and lookup, RVA/VA/file
address conversion, disassembly, raw byte reads, wildcard and mnemonic/operand-text
search, provider-derived basic blocks and typed direct CFG edges, instruction-aware
signature generation, offline named-signature listing, evidence-gated signature
persistence, decompilation, both xref
directions, string listing and search, imports,
exports, interpretation lookup, review-only rename/comment/tag and
data-type/function-prototype proposals, and
evidence-backed provisional findings.
Every result is a versioned envelope
carrying byte identity, revision, provenance, and `completeness`, so a
truncated answer cannot be read as a complete one.

The stable contract now distinguishes malformed requests with
`INVALID_ARGUMENT`; `ADDRESS_NOT_MAPPED` is reserved for syntactically valid
addresses with no decoded mapping. Direct prompt references retain their full
`#delver_...` names so generic tools from another extension cannot collide.
Dispatcher and direct-tool telemetry now records dispatch, backing-service,
serialization, adapter transport, and model-visible total durations. The events
contain only bounded capability/outcome metadata and measurements, never sample
paths, hashes, arguments, model ids, or extracted content.

P3b now has its private renderer command gateway. `_delver.agent.capabilities`
and `_delver.agent.invoke` are the only extension-host entry points, and both
delegate directly to `IDelverAgentService`. The gateway validates a bounded
plain-JSON request before dispatch, rejects cycles, non-finite numbers, bigint,
oversized/deep payloads, unknown top-level fields, and spoofed caller kinds, and
returns stable failures as JSON data rather than lossy remote exceptions. It
opens no target, starts no analysis, and owns no capability logic. Cancellable
bridge calls multiplex `invoke` and `cancel` operation envelopes through the
existing invoke command, with bounded request ids and active-call counts; a
third private command was not added.

The built-in `delver-agent-bridge` extension now has the first external-
transport slice: bounded `Content-Length` framing and a transport-independent
authenticated DTP connection state machine. It accepts only `initialize`,
`agent/capabilities`, `agent/invoke`, and `agent/cancel`; binds caller identity to the
authenticated connection; rejects duplicate ids and excess concurrency; and
propagates explicit cancellation and disconnects into the renderer before
suppressing late writes. The shared Rust transport now bounds
headers, JSON payloads, and bulk binary frames before allocation and rejects
duplicate or non-decimal length headers.

The `delver-agent-relay` Rust executable now provides the thin OS
boundary needed by the bridge: one owner-only named pipe/Unix socket connection
is copied byte-for-byte to stdio and the process returns when either direction
ends. Windows retains `FILE_FLAG_FIRST_PIPE_INSTANCE` through the first accept,
rejects remote clients, and keeps its current-user DACL. Unix refuses existing
socket paths and requires a current-user-owned mode-0700 parent. Readiness is one
exact bounded JSON line on stderr; stdout remains protocol bytes only. The relay
is staged with the other native binaries and starts only for a trusted,
single-root local workspace.
Its opt-in bootstrap mode now queries the connected peer from the kernel—named-
pipe client PID on Windows, `SO_PEERCRED` PID/UID on Linux/Android, and peer UID
on BSD-family systems—and emits one bounded control record before starting byte
copying. Normal DTP mode emits no peer metadata.

The extension-side supervisor and backpressure-safe stdio transport are now
composed by the production activation owner. The
supervisor resolves only Delver-owned absolute binaries, creates a fresh
endpoint/token per attempt, strips ambient credentials from the relay process,
requires strict bounded readiness within five seconds, drains but never logs
post-readiness stderr, bounds queued writes to 8 MiB, and deduplicates
error/exit cleanup and capped exponential restarts. Credential handoff to an
independently launched MCP adapter now has a live bootstrap protocol core: one bounded
claim must match the registry entry, window instance, and canonical root
fingerprint; verified-peer authorization defaults to deny; DTP is provisioned
before a 15-second, 256-bit lease is issued; and atomic endpoint-generation-bound
consumption rejects replay. Disconnect, write failure, endpoint death, expiry,
and disposal revoke unconsumed leases. A concrete in-memory authorizer now holds
at most one 30-second approval for the currently connected, OS-attested peer.
Each request has a fresh opaque ID; disconnect, expiry, denial, disposal, and
stale approvals fail closed, so PID reuse cannot inherit authorization. The
localized modal adapter now offers only **Allow Once** and **Deny**,
shows OS-attested PID/UID separately from the explicitly unverified application
name, and grants only the exact live request ID. Dismissal, prompt failure,
expiry, disconnect, and adapter disposal deny; a stale unresolved modal also
prevents prompt stacking. Client display names containing control or bidi
formatting characters are rejected before authorization. `activate()` publishes
no endpoint until all eligibility and security gates pass.

The bootstrap relay manager now owns the race between the native
relay's stderr attestation and stdout claim bytes. It attaches a combined,
bounded READY/PEER decoder and a one-claim input gate before invoking the
publication seam. Publication is one-shot and is removed before buffered claim
fragments are released to a verified-peer bootstrap session. Cross-stream
arrival order, reentrant publication, oversized input, readiness/peer timeout,
response-write backpressure, and idempotent cleanup are covered in both injected
tests and production activation.

The non-secret rendezvous registry format and file store are now
implemented. Each publication is one immutable, bounded JSON file with a fresh
entry/window generation, root fingerprint, local bootstrap endpoint, owner PID,
and the relay's absolute peer deadline; it contains no token, nonce, path, target
metadata, or client label. Same-directory temp write/fsync plus atomic no-replace
link publication avoids a shared manifest and cross-window locking. Readers cap
enumeration and per-file allocation, reject malformed/future/expired/wrong-
platform entries, and prune only well-formed expired entries or old temp files.
Disposing one window removes only its exact entry. POSIX preparation requires
the four Delver-owned directories to be current-user 0700 and creates each
component only after checking the previous one. Windows now has an audited native
provider in `delver-agent-relay --prepare-registry-directory`: every owned
component is opened without following reparse points and must have the current
token user as owner plus one exact, protected, inheritable full-control ACE for
that SID. New components receive that descriptor at creation; mismatched
existing directories are rejected, never repaired. The TypeScript one-shot
controller supplies only whitelisted `LOCALAPPDATA`/Windows boot variables,
requires empty stdout, one bounded exact readiness record, clean exit, and a
five-second deadline. Production activation injects this provider on Windows
and uses strict owner/mode validation on POSIX.

The `root-v1` module now gives the extension and future MCP adapter one
normative workspace-routing fingerprint. It requires exactly one local,
non-remote, non-untitled directory, resolves filesystem aliases before hashing,
uses strict platform-specific canonical forms with no Unicode normalization,
and locks the domain-separated SHA-256 preimage with drive, UNC, POSIX, and
composed/decomposed Unicode vectors. Unsupported platforms and malformed,
missing, inaccessible, non-directory, or ambiguous roots fail closed. The
fingerprint contains no path and remains routing metadata rather than identity.

The per-window rendezvous lifecycle is now production-composed behind the
startup activation gate. Bootstrap sessions and relay attempts expose first-wins close outcomes;
silent or partially framed peers have a five-second claim deadline; authorization
distinguishes grants, denial, expiry, cancellation, busy suppression, and an
unavailable verifier. Registry removal is awaited before buffered claim bytes
are released, and shutdown waits for in-flight publication and endpoint cleanup.
Token-free lease events let the lifecycle block publication while a credential
is live, penalize an unconsumed/invalidated grant, and reset counters only after
successful DTP initialization consumes the token. One scheduling gate serializes
root generation changes, stale modal prompts, active leases, asynchronous
teardown, and ±20% jittered idle/technical/prompt backoff. Rapid root changes
rotate IDs and cannot resurrect an old publication. Every root refresh first
unpublishes bootstrap, aborts pending provisioning, and closes authenticated
private DTP relays before applying the next fingerprint. Extension shutdown
awaits registry removal, native process exit, and endpoint cleanup.

Production activation now runs on `onStartupFinished` but remains inert for
Restricted Mode, remote/virtual/untitled workspaces, unsupported platforms, and
zero or multiple roots. A real workbench launch verified that Restricted Mode
creates no registry, granting trust publishes one token-free 30-second entry,
and closing the window removes the entry and reaps the relay.

The gated real-process path now passes on Windows: a raw Node client claims the
real bootstrap pipe, receives an explicitly granted 256-bit one-time token,
connects a second real relay, initializes DTP, reaches capabilities/invoke, and
cancels the pending renderer request on disconnect. That test exposed two native
duplex bugs that unit-memory streams had hidden. The relay now flushes every
forwarded chunk, and the Windows server polls pipe availability before reading
so a pending synchronous read on a duplicated handle cannot serialize and
deadlock the response write. The Windows writer flushes kernel pipe buffers
before considering delivery complete.

The standalone native `delver-mcp` adapter is now implemented and staged with
the other Delver binaries. It requires an explicit absolute `--root`, computes
the same root-v1 fingerprint as the extension, strictly selects one current
registry publication, performs the one-shot bootstrap claim, consumes the
private DTP token, and keeps one authenticated session for dynamic tool calls.
Its stdout is bounded UTF-8 MCP JSON-RPC over newline-delimited stdio; it
negotiates public protocol revisions through `2025-11-25`, enforces initialize
lifecycle, keeps ping responsive while tool workers run, maps MCP cancellation
to `agent/cancel`, suppresses late responses, and bounds shutdown even when a
backend does not cooperate. The gateway capability response now carries the
canonical title, model description, and input schema for all sixteen tools, so
the adapter does not duplicate TypeScript tool definitions. Successful calls
preserve the full Delver result envelope as text and structured content; stable
Delver failures remain MCP tool errors rather than protocol errors.

Discovery costs nothing. `delver_capabilities` answers with no project open and
starts no target, no analysis, and no decompiler — the plan's hard performance
rule, and now an asserted one rather than an intention. Saved pseudocode is
likewise a zero-backend hit: an offline `.delverdb` answers `delver_decompile`
from the project while `delver_disassemble` and the xref capabilities report
`TARGET_NOT_ATTACHED`, which tells an agent to ask for the sample rather than
conclude the function is empty.

Pagination cursors are bound to the content hash, revision, capability, **and**
the filter arguments that produced the sequence. Byte binding was designed in;
filter binding was not, and was found by the test pass — an offset into the
functions matching `crypt` is meaningless against those matching `alloc`, and
reusing it skips and repeats rows with nothing in the result to say so. Both
now fail as `STALE_REVISION` instead.

Addresses cross the boundary as canonical lowercase `"0x..."` strings in both
directions. A JSON number above 2⁵³ is rejected outright rather than mapped to
a nearby instruction, since by the time it reaches the dispatcher the precision
is already gone.

Sample-derived payloads — strings, symbol names, pseudocode identifiers — are
labelled `untrusted` in provenance, and the tool layer prepends a separate
warning part so a payload that quotes or truncates cannot swallow it.

The direct tools register into a `delver-analysis` tool set built from the
dispatcher's own capability list, so the chat picker cannot advertise a
capability the dispatcher lacks. `delver_capabilities` is the only tool without
a `delverTargetOpen` `when` clause.

Generated function names are now backend-neutral and image-relative throughout
the UI and pseudocode: unnamed entries display as `SUB_<RVA>`, and PyGhidra C
output rewrites only Ghidra-generated `FUN_<VA>` identifiers by subtracting the
program image base. Meaningful backend symbols and analyst-authored names remain
unchanged, while legacy lower-case `sub_` project placeholders are still
recognized as generated names. The Ghidra Program itself is not renamed.

Pseudocode failures now expose copyable diagnostics plus explicit Retry and
Restart Decompiler actions. Retry bypasses read-through caches for that exact
function. Restart cancels active PyGhidra operations, disposes the persistent
worker, starts a fresh process generation through the backend-neutral IPC seam,
and only then re-decompiles; existing saved pseudocode remains durable if
recovery fails.

Native decompiler cache inspection and cleanup are now explicit Command Palette
actions. Inventory reports the fixed cache path, Ghidra project count, files,
and total bytes without starting a backend. Cleanup requires confirmation,
cancels active work, disposes PyGhidra, validates that the recursive-delete
target is the absolute `delver/decompiler-cache` directory, and never touches
portable `.delverdb` files. Live pseudocode provenance shows request duration;
the latest-performance action breaks out startup, handshake, target analysis,
function recovery, decompilation, and serialization timings.

Live sessions now prepare PyGhidra in the background before the first F5:
worker startup, target hash verification, and persistent project/program import
begin as soon as the session opens, with delayed status-bar progress. Target
opens are coalesced by session and content hash, so an F5 arriving during
preparation joins the same operation and cannot enqueue a duplicate Ghidra
import. Full auto-analysis is deliberately not scheduled yet because Ghidra
would monopolize the single JVM-owning thread and could make interactive F5
slower; it needs an interruptible, resumable scheduling design first.

Pseudocode-to-listing synchronization now preserves exact discontiguous source
ranges. The focus bus carries those half-open ranges alongside its legacy
contiguous bounding selection, and the virtualized listing highlights only
instructions whose `[RVA, RVA + length)` overlaps a real source range. Gaps
between blocks stay unpainted, newly materialized rows read the current ranges,
and location-only navigation clears stale semantic highlighting.

Function revision comparison now has a bounded backend-independent primitive in
`platform/delver/common/functionRevisionMatcher.ts`. It creates versioned SHA-256
fingerprints from listing rows, ignoring row/RVA movement and representing direct
targets as local instruction indices or external edges. Matching accepts only a
fingerprint unique in both revisions; repeated thunks remain ambiguous. Results
carry confidence, method, source/target content hashes, and fingerprint
provenance. Structural fuzzy matching and instruction-level remapping remain
explicit future work.

Portable projects now use revision-aware SQLite schema v6. Explicitly opening
the same target path probes the current bytes and, when their SHA-256 changed,
offers Add as New Revision / Create New Project / Cancel. Adding a revision is
atomic and preserves every prior snapshot. The analysis server emits normalized
function fingerprints; unique exact matches are stored with confidence and
provenance, then existing names, comments, and tags are copied as attributed
import edits only when the destination has no authored value. Ambiguous or
changed functions are left untouched, and decompiler output is regenerated.
Schema-v1 and schema-v2 projects upgrade in place without losing their initial
analysis. The `findings` table retains one validated payload per finding and
binds it to the matching target revision; v4 added one append-only human decision
per finding without rewriting the original model-authored payload, and v5 adds
bounded dispatcher exchanges keyed by revision and call id.

Session persistence is now specified as a portable, IDA-like project lifecycle.
Opening a raw binary creates an untitled session. Once durable analysis content
exists, close, target replacement, and shutdown prompt Save / Don't Save /
Cancel. Saving creates a user-chosen `.delverdb`; named projects then autosave
incrementally. The single SQLite file retains functions, strings, facts,
pseudocode, interpretation, findings, provenance, and useful session state, but
never sample bytes, and it can open without the original target.

ADR 0005 supersedes the current per-content-hash JSONL location decision. The
existing JSONL implementation is now a migration source, not the future project
format. Ghidra projects remain content-hash-keyed local user-data caches qualified
by backend version and analysis profile. They are disposable, nonportable
accelerators; `.delverdb` is the backend-neutral record of analysis and user
work. Future IDA native databases follow the same boundary.

The production decompiler direction is now a backend-neutral persistent host,
with isolated workers per engine. The first PyGhidra adapter keeps one JVM plus
an analyzed Ghidra Program and DecompInterface alive across function requests. The current
headless Ghidra path remains a compatibility fallback. The future IDA adapter is
now specified as a Python IDALib (`idapro`) worker targeting a user-provided IDA
Pro 9.0+ and appropriate Hex-Rays license. It uses the existing IDAPython APIs
outside the GUI, serializes every database operation on IDALib's initialization
thread, and may restart the isolated worker for hard cancellation. It adapts
Hex-Rays text, variables, diagnostics, and ctree/eamap-derived line↔RVA
provenance through the same host protocol without sharing a runtime with
PyGhidra. IDBs stay content-hash/version/profile-qualified local accelerators;
p-code, microcode, and ctree remain optional backend-specific capabilities.

The versioned JSON-lines host and PyGhidra worker are implemented. The shared
process supervises one worker, negotiates backend identity and capabilities,
multiplexes requests, forwards cancellation, retains targets per analysis
session, clears stale target state after a worker restart, and falls back to the
one-shot headless backend only when discovery or the initial handshake fails.
Errors from a successfully started backend are reported directly instead of
triggering a second slow decompilation. The Python worker verifies the target's
SHA-256, serializes all Ghidra work on the JVM-owning main thread, and reserves
stdout exclusively for protocol frames.

P2a now has an injectable `IDelverDecompilerService` boundary. Its stable result
shape carries C text, recovered variables, backend identity, and one-based source
lines mapped to discontiguous half-open RVA ranges. Bidirectional lookup helpers
handle overlapping mappings without flattening provenance. The registered
scaffold reports unavailable explicitly until the headless Ghidra backend lands,
and cancellation is rejected before invoking a backend.

The Ghidra adapter now pins the scaffold to Ghidra 12.1 and strictly decodes a
versioned JSON wire format. RVAs remain hexadecimal strings until validation, so
addresses above `2^53` retain precision. Unknown fields, incompatible schema
versions, invalid ranges, and output for the wrong function are rejected. The
node-side backend boundary discovers the configured platform launcher and
bundled script, reports actionable unavailable states, forwards cancellation to
an injected runner, and validates its response before exposing it to consumers.

The scaffold is now executable end to end through the shared process. The
`DelverDecompile.java` post-script uses the pinned 12.1 API to emit pseudocode,
recovered high variables, and merged line provenance. Each request copies the
target into an isolated temporary project, verifies that snapshot against the
session SHA-256, launches without interpolating target paths into a shell command,
kills the full process tree on cancellation, and removes the project afterward.
`delver.decompiler.ghidraHome` is a machine-scoped setting; without it the service
continues to report the backend as unavailable.

The official Ghidra 12.1 distribution has now been exercised end to end on
Windows against `provider-file.exe`. The entry function produced schema-v1 JSON,
160 characters of pseudocode, three line mappings, and two recovered variables.
That smoke test corrected the pinned `HighSymbol` storage call to `getStorage()`;
a source-level regression test now prevents the nonexistent
`getVariableStorage()` call from returning.

Functions now open a read-only `delver-pseudo:` editor for the selected RVA.
The editor uses Monaco's existing C mode so syntax coloring, folding, find, and
the normal code-editor navigation work without a second grammar. Moving its
cursor publishes the line's first instruction plus the bounding recovered RVA
selection; focus changes from the listing move the pseudocode cursor back to the
first matching line. The unavailable-backend path stays inside the editor and
points directly to the Ghidra 12.1 setting instead of failing the open command.

Overview now acts as the workspace table of contents: Entry Point publishes its
wire-safe RVA through the focus bus, Instructions opens the listing, Functions
and References reveal their panes, and Strings opens its editor page. The row
model is separated from contribution registration and has a focused navigation
contract test, including an address above `2^53`.

Built-in extension synchronization now keeps `vscode-js-profile-table` on its
official GitHub release asset. Open VSX serves different bytes for version
1.0.11, while both Microsoft Marketplace and the official GitHub release match
the upstream-pinned SHA-256; the integrity pin remains unchanged.

Fresh development checkouts now build the Rust provider and analysis server
during pre-launch when their debug binaries are absent. Release staging includes
`server-analysis`, and a missing executable reports its spawn error immediately
instead of masquerading as a ten-second listener timeout.

Functions and Imports filters now keep their input visible when a query has no
matches. Filtered-empty state no longer activates the view welcome overlay, so
clearing or editing the query always restores matching rows. Filtered roots use
search-only tree identities, preventing automatic search expansion from leaving
every normal module or function group open after the query is cleared.

Functions and Imports now have persistent, debounced filter boxes. Function
filtering covers authored/placeholder names, RVAs, and source across the complete
set; Imports covers modules, symbols, ordinals, and IAT RVAs.

The Functions pane no longer stops after 1,000 swept entries. Large categories
are exposed as lazy 1,000-row pages, so all ~178k results remain reachable while
each expansion and refresh stays bounded. Rename refresh is now incremental and
does not rescan every function for comment or tag edits. Strings already lives in
an editor page with its own filter and encoding column, completing G6.

The listing now renders authored names at any RVA and comments after the operands
on their instruction line. Function starts retain their placeholder/authored landmark
line. Interpretation is owned by the real instruction row rather than inserted
as synthetic analysis rows, so paging ordinals and address mapping stay exact.

Each label is one bounded display line and adds one deterministic line height;
comments do not change row height. Imported multiline comments fold newlines only
for display while the stored value remains unchanged. Accepted edits re-splice
only their buffered row, updating immediately while preserving focus and selection.

`;` opens Set Comment while a listing row is selected; input focus suppresses the
shortcut so semicolons can be typed into the prompt. Empty input clears by
appending an empty-value edit. F2 Rename and Set Comment share one editing path.

Function rows now carry wire-safe RVA handles. Rename is an inline row action and
Set Comment is in the row context menu; both update the listing and Functions pane
through the interpretation event.

Tags are stored as canonical arrays and render inline as `#tag` tokens. `T` edits
the selected instruction's tags. Imports, addressed Exports, References, and
Functions expose the same Rename, Set Comment, and Set Tags row actions; forwarded
exports remain excluded because they have no RVA in this image.

`Ctrl+Z` now undoes local interpretation with an attributed compensating append.
It walks backward through uncompensated accepted edits without rewriting history.
`Delver: Revert Interpretation by Author...` reconstructs state without one
author's accepted edits and appends one compensation per affected field. Merged
imports are resequenced so compensation references remain unambiguous.

Listing navigation also maps Mouse4/Mouse5 to the existing focus-history
back/forward stack. The events are captured before the table or Chromium can
consume them, and Alt+Left/Alt+Right remain equivalent keyboard paths.

References now render proven function-relative locations such as
`decrypt_config+0x2A`, with the raw RVA and reference kind in the description.
Exact entries use the function name; addresses without a known containing range
remain raw rather than being attributed to a guessed owner. Renames refresh the
pane immediately.

The inline-row decision is recorded in [p1-plan.md](p1-plan.md), and the listing
height constraint is updated in [ide-architecture.md](../architecture/ide-architecture.md).

Function names on listing landmark lines are now the product accent instead of
`symbolIcon.functionForeground`, through a registered `delver.listing.functionName`
color. Registering it exposed that the other four `delver.listing.*` IDs are
declared in the theme files but never registered — a theme entry for an
unregistered ID emits no CSS variable, so those four roles currently do nothing.
The listing's mnemonic and branch-target colors still borrow
`debugTokenExpression.*` and `textLink.foreground`. See
[rebranding-plan.md](rebranding-plan.md) §2.1.

Separately, the rebrand had replaced only the OS artwork under `resources/`, so
every renderer-drawn surface still showed the VS Code logo — most visibly the
titlebar app icon. Those come from source-tree SVGs
(`browser/media/code-icon.svg` and the four `letterpress-*.svg` watermarks), which
`scripts/generate-artwork.py` now traces from `resources/delver/logo.png` along
with the OS icons, so the whole set regenerates from one master.

## Verification

Last full run 2026-08-29, against freshly built debug and staged release
binaries. The TypeScript figure is from the full suite selection —
`scripts\test.bat --grep "Delver|Ghidra|InterpretationLog|DecompilerWorkerHost|provider exit escalation|PyGhidra"`.
`--grep Delver` alone misses six suites; see
[working-with-ai.md §8](../development/working-with-ai.md).

- Rust workspace: 234 passing, including the resumable string scan (a page walk
  at every page size from 0 upward reproducing one whole-image scan exactly, over
  a tidy fixture and over pseudo-random printable-heavy images; resuming inside a
  string; an oversized first address group that must still advance; and sections
  handed over out of virtual-address order), the correction set's atomic refusal,
  `FunctionSource::Authored` outranking every derived source, the undefined sweep
  guess that must not reappear one byte later, the undefined call target whose
  instructions and inbound call xref survive, the S3 call-graph/path corpus,
  split indirect-flow classification, RVA-0 syscall regression, provider mmap
  clamp, file-bounded hostile-section allocation, the paged xref export's
  end-of-walk bounds, observed global-data inventory, subsystem parsing that
  keeps an unrecognized value rather than collapsing it, and the entry-role
  walk's decline conditions — which is all it does on a real binary
- Golden corpus: 6 samples match
- `DelverAnalysisSession`: passing against the rebuilt binaries; the generated PE
  import directory is accepted by the real parser, both direct-IAT and
  import-thunk resolution paths are exercised, and the whole xref table walks out
  one reference per page with `next_start` dropped exactly at the end
- Delver TypeScript suites: 397 passing, including the two-phase strings walk
  (the retained list, the continuation into a scanned image, and an offline
  project that refuses to scan and says no cursor will reach the rest), function corrections through
  the `.delverlog` validator and into the accepted set pushed at open,
  dispatcher/tool contracts, signature policy/scan presentation, project interpretation isolation, retained
  cross-reference storage and its v7→v8 migration, offline xref answers, the
  `schemaVersion: 2` semantic snapshot in the decompilation cache key and against
  saved pseudocode, both refusals that keep a partial type model from reaching the
  backend, composite anchors through the `.delverlog` validator and into the
  semantic snapshot, the empty-snapshot attribution that keeps saved pseudocode
  readable on a backend that cannot apply types, and the now-live native
  integration suite
- Golden corpus: 6 samples match; `valid-layers-check` clean
- Python decompiler worker: 10 passing
  (`python -m unittest discover -s scripts/ghidra -p "test_*.py"`), including
  `test_semantics_are_canonical_bounded_and_sorted` — a snapshot is refused
  unless its schema version is 1 or 2 and every declaration is non-empty,
  bounded, and in ascending unique RVA order, and
  `test_composites_are_identified_bounded_and_offset_ordered` — composites
  ascending and unique by name, fields ascending by offset and inside the
  declared size, and any `kind` other than `struct` refused
- Client typecheck and fresh transpilation: clean
- Signature UI/migration focused run: 25 passing, covering generation policies,
  earlier-revision classification and promotion gating, SQLite `signature`
  mappings, retained proof validation, conflict-preserving annotation transfer,
  idempotent Review proposals, and fail-closed single/bulk IDAPython generation
- Agent dispatcher and contract: 61 passing. They cover zero-analysis
  discovery, per-capability missing-project handling, attachment refusal, the
  zero-backend saved pseudocode path, an address above 2⁵³, unsafe JSON
  numbers, count clamping, cursor binding to bytes/capability/filter,
  containing-function resolution including padding after a known end, offline
  RVA/VA/file-offset conversion including virtual zero-fill tails, bounded
  image/file byte reads with exact little-endian integer decoding, wildcard
  scans across provider chunks, overlapping matches, revision-bound search
  cursors, complete negative scans, short-read refusal, instruction-aligned
  relocation-stable signatures, bounded uniqueness proofs, retained-evidence
  cross-revision proofs and fail-closed mismatches, proven xref-site fallbacks,
  evidence-gated named signature saves, and offline named-signature listing,
  untrusted string labelling, authored names beating placeholders,
  cancellation, envelope shape, attributed offline rename/comment/tag
  proposals, validation-atomic malformed batches, and the write commit boundary
- Agent tool presentation: 7 focused tests cover catalog/tool identity, exact
  byte/address and signature schemas, bounded review-only proposal schemas, and
  the composite and function-correction arms; generated discovery reports 35
  tools
- Named-signature/project focused run: 95 passing (19 SQLite store, 8 project
  service, 61 dispatcher, 7 tool-definition), plus 8 command-gateway tests,
  including v1-to-v8 migration, reopen, per-revision isolation, atomic upsert,
  and case-insensitive replacement with a stable id
- Session/decompiler regression run: 41 passing
- Provider/analysis session: 7 passing, including verified image-RVA and raw
  file-offset binary-frame reads
- Proposal review state: 5 log-level tests (proposal invisible to the view but
  present in the log, acceptance authored by the reviewer with the proposal
  traceable, rejection recording the declined value, fail-closed resolution of
  unknown/non-proposed/already-decided sequences, replay restoring pending and
  decided state), 2 service-level tests (persisted proposal then decision, and a
  invalid batch that writes no resolutions), and 1 store test covering resequenced `resolves`
  references and refusal of a malformed one
- MCP client configuration: 5 focused tests covering absolute-path binding,
  optional untrusted-label validation, rejection of relative paths and
  control/bidi or oversized labels, the exact pasteable serialization, staged
  adapter resolution with no `PATH` fallback, and one distinct availability
  reason per ineligible window shape
- Private command gateway: 8 passing, covering the two-command surface,
  canonical delegation, JSON round-tripping, structured failures, bounded
  request/operation validation, cancellation propagation, and idempotent
  cancellation multiplexing
- DTP bridge, relay supervision, bootstrap manager, authorization UI, root fingerprinting, rendezvous lifecycle/registry, production activation, private relay ownership, and leases: 95 passing, covering fragmented/coalesced bounded framing,
  malformed and oversized input, authentication, caller binding, pre-init
  refusal, duplicate ids, concurrency limits, out-of-order correlation, and
  explicit/disconnect cancellation with late-write suppression; absolute
  executable resolution, 256-bit token rotation, credential-free child
  environments, strict readiness, backpressure, overflow/error closure,
  restart backoff/stability reset, dispose/no-respawn, default-deny and exact
  one-shot peer authorization, PID-reuse isolation, platform identity checks,
  modal allow/deny/dismiss/failure behavior, exact-item grant identity,
  stale-modal prompt suppression, verified/untrusted prompt labelling, and
  control/bidi display-name rejection,
  exact window/root routing, provisioning order, failure
  revocation, TTL boundaries, one-time consumption, replay rejection, strict
  peer-control decoding, cancellation before attestation, publication/listener
  ordering, cross-stream claim buffering, bounded pre-attestation input,
  truthful response-write backpressure, and one-shot unpublication;
  lock-free multi-window registry publication, strict non-secret schema and
  platform paths, atomic collision refusal, bounded stale/malformed filtering,
  selective pruning, relay-deadline propagation, and late-publication cleanup;
  exact native-helper arguments/environment, fragmented bounded readiness,
  stdout/extra/oversize/nonzero/timeout/cancellation refusal, and path matching;
  focused extension compile and ESLint clean
- Shared Rust DTP transport: 15 passing, including owner-only listener
  round-trip, first-instance namespace reservation, remote-client rejection in
  the bind flags, header/JSON/binary size enforcement before allocation, and
  protected private-directory creation, reaudit, concurrency, and file-component
  rejection
- Rust agent relay: 2 passing bidirectional byte-transparency/lifecycle and CLI-mode tests;
  the same connection asserts the OS-derived peer identity, and the executable
  emits exact JSON readiness only after a successful bind
- Live Windows relay smoke: readiness followed by an opt-in peer control record
  whose kernel-reported named-pipe client PID matched the connecting process;
  relay exited after disconnect
- Real bootstrap→private-DTP process integration: 1 passing, covering in-memory
  publication, kernel peer identity, explicit one-shot authorization, private
  relay provisioning, 256-bit lease handoff/consumption, DTP initialization,
  gateway caller binding, disconnect cancellation, both child exits, and
  consumed-bootstrap reconnect refusal
- Real Windows registry-helper integration: 1 passing, covering protected native
  hierarchy creation/reaudit followed by actual file-registry publish, list, and
  disposal; the legacy bootstrap process integration still passes unchanged
- Tool reference contract: 1 passing; every prompt reference retains its full
  globally unambiguous `delver_...` capability id
- Isolated workbench: the renderer registers exactly `_delver.agent.capabilities`
  and `_delver.agent.invoke`; no third `_delver.agent.*` command exists. All 16
  compiled chat definitions expose their full `delver_...` ids as prompt
  references
- Live workbench, `provider-file.exe` (5,282 functions, 203,588 instructions),
  Claude Haiku 4.5 in the built-in chat:
  - all 16 tools plus the `delverAnalysis` set register; with no target open
    only `delver_capabilities` and the set are offered, and the remaining 15
    appear once a target opens — the `delverTargetOpen` clause holds in both
    directions
  - `delver_capabilities` reported 16 capabilities, 4 core / 12 analysis, and
    an unconfigured decompiler with its actionable reason rather than a
    generic failure
  - a real investigation resolved `SUB_1000`/`SUB_1350`/`SUB_1510`, decoded the
    x86-64 prologue at `0x1000` with exact instruction lengths, and attributed
    the single xref as `SUB_1350+0x113` (`0x1463 − 0x1350`, confirmed by hand)
  - the model reported `list_functions` and `disassemble` as partial and
    `xrefs_to` as complete, which is the envelope doing the job it exists for
  - **not yet exercised:** decompilation (Ghidra home unset in this profile),
    the offline `.delverdb` path, and the §4 latency budgets
- Targeted ESLint on the agent service, contract, tests, and both `delverAI`
  contribution files: clean. The custom `delver-address-is-bigint` rule caught
  pagination indices named `offset`, which reads as an address offset in this
  codebase; they are now `startIndex`/`nextIndex` rather than suppressed
- Client typecheck: clean
- Generated function naming: 5 common tests and 8 Python worker tests passing
- Listing and reference placeholder presentation: 6 passing
- SQLite snapshot, revision, migration, and finding persistence: 9 project-store tests passing
- Tool-call record validation and JSON round-trip: 3 passing
- Finding/decision domain validation and 64-bit wire round-trip: 4 passing
- Project finding/tool-call lifecycle and autosave: 4 passing
- Review tree projection, evidence navigation, and tool-result document: 4 passing
- Agent dispatcher: 28 passing, including retained exchanges and validated finding citations
- Generated chat/MCP tool definitions: 3 passing with a twenty-tool catalog
- Decompiler recovery/restart service: 14 focused tests passing
- Cache cleanup boundary: 1 focused filesystem test passing
- Decompiler cache/performance service: 15 focused tests passing
- Background target preparation: 5 PyGhidra adapter and 16 service tests passing
- Discontiguous focus/highlighting: 13 focus-bus and 2 range tests passing
- Client typecheck and transpilation: clean
- Native MCP adapter: 20 Rust tests passing; Clippy clean with warnings denied
- Agent bridge: 95 unit tests and 2 real-process integration tests passing
- Build-tool typecheck: clean with `delver-mcp` staged and marked executable

- Function revision normalization/matching: 8 passing; targeted ESLint clean
- Revision-aware SQLite store and v1 migration: 8 passing
- Updated-target prompt/session lifecycle: 19 passing
- Interpretation model/service/store, listing presentation, and handles: 25 passing
- Mouse history mapping plus focus-history behavior: 12 passing
- Function-relative reference labels: 2 passing
- Functions paging/filtering and Imports filtering: 9 passing
- Listing paging/model: 12 passing
- Functions interpretation handles: 2 passing
- Overview navigation contract: 1 passing
- Targeted ESLint: clean on all changed interpretation and pane-action files
- Client typecheck: clean
- Build-tool typecheck: clean
- Fresh native debug build: `provider-file` and `server-analysis` staged
- Missing-provider startup error: 1 passing
- Decompiler contract, protocol validation, worker lifecycle/discovery, IPC
  bridging, cancellation, caching, and line maps: 21 passing
- Python worker protocol and JPype compatibility: 5 passing
- Real persistent Ghidra 12.1 / PyGhidra 3.1.0 smoke: handshake in about 3 s;
  one target analysis plus two successful `0xd8580` decompilations in one
  77.5 s worker lifetime
- Pseudocode line/focus mapping: 2 passing in Chromium
- Real Ghidra 12.1 headless smoke: schema v1, `0xd8580`, 3 line mappings,
  2 recovered variables
- Isolated workbench check: opening `provider-file.exe`, expanding Functions,
  and clicking `sub_1000` opened a full-size `Pseudocode: sub_1000` editor with
  the expected Ghidra configuration guidance
- Existing navigation test cannot run in the Node harness because its EditorPane
  import reaches CSS; this is a harness limitation, not a test assertion failure.

## Next

S3 is functionally complete: profiles, callers/callees, bounded call graphs,
path queries, and the first confidence-bearing indirect targets all exist. What
remains is the weaker half of resolution — a vtable or dataflow-derived target,
which lands on the `probable` confidence tier the enum already reserves. Until
then every such site is counted honestly rather than guessed at, and it is those
counts that hold `delver_call_graph` and `delver_call_paths` to `partial`.

S4 now has the observed-global substrate, reviewed authored types/prototypes,
content-wide semantic cache stamps, and transactional PyGhidra application.
Next narrow each stamp to the globals and callees actually consumed by one
function, then extend the authored model to structures, enums, and local
variables. Do not infer sizes or read/write modes in the native global pass
merely to make the inventory look richer.

The static baseline retains proposals/findings and their cited tool results,
lets a human decide them, and navigates concrete range evidence. The xref half of
the plan's result-loss list is now paid (see Just landed). What remains on it is
**listing rows**, which were deliberately not taken in the same pass: they are an
order of magnitude larger than the xref table, and the choice between retaining
them whole, retaining only what an investigation touched, and not retaining them
at all is a real decision rather than a mechanical repeat of ADR 0012. Until it
is made, an offline project still cannot disassemble.

The two other named gaps are unchanged: long pseudocode is prefix-truncated with
no continuation cursor, and a capped string scan cannot be reached by paging.

For P3b, root-v1, the per-window lifecycle/backoff owner, production extension
composition, approval adapter, root-scoped private relay ownership,
`onStartupFinished` activation, and the native stdio MCP adapter are complete.
The generic `.mcp.json`, client recipes, and the configuration-generating
command are published. Next run the same real-binary workflow through Codex,
Claude Code, Kimi, Cursor, and the minimal reference client. Add cross-transport result conformance and latency
measurements before calling P3b complete. Dynamic `tools/list_changed` and
operation progress remain deliberately unadvertised until DTP has real events;
the adapter does not synthesize capabilities it cannot observe.
The two-command cancellation path, owner-only relay, peer attestation,
connection-bound authorization primitive, supervisor, race-safe one-shot
bootstrap manager, bootstrap validation, single-use lease primitive, and real
bootstrap-to-DTP process conformance are complete.

In parallel, finish the one remaining P3a acceptance check: open the real Auto-updater
`.delverdb` without its sample, ask built-in chat for saved pseudocode, verify no
provider or decompiler starts, then attach the matching sample and exercise live
decompilation. Capture the new stage measurements against the §4 budgets. The
direct live-session investigation and private command conformance suite already
pass.

Registering the tools means `contrib/delverAI` imports the chat contrib's
`ILanguageModelToolsService`, a knowing exception to invariant 9. There is no
other contribution point for language-model tools, and upstream's own
`browserView` contrib does the same; the exception is noted here so it is not
mistaken for drift.

The P2b project/decompiler integration slices now restore saved analysis
categories and pseudocode without a provider or Ghidra call, automatically
attach a saved in-workspace target only after SHA-256 verification, retain an
offline fallback plus manual Locate Target, and expose
actual backend state and phase timings. PyGhidra failure no longer silently
starts the minute-long headless path; headless selection is explicit.

Combined verification: session lifecycle 25 passing, decompiler/worker/status
29 passing, SQLite project store 10 passing, Python worker 6 passing, client
typecheck and transpilation clean.

Next, visually exercise Open Project, Locate Target, saved pseudocode provenance,
Close Project, explicit recovery, and explicit headless selection against the
real Auto-updater project. Then design interruptible/resumable full-analysis
scheduling or begin the backend-neutral IDA test-double boundary. The isolated launch helper was repaired for
Windows PowerShell parsing, but automated visual verification remains blocked
while the only complete source profile has a Chromium Cookies lock; EditorPanes
still have no unit UI harness in this fork.

After the host boundary is covered by backend-neutral contract tests, add an IDA
test double so Ghidra-specific names cannot creep back into the protocol. Exact
discontiguous pseudocode selection painting remains the next UI-side P2 slice.
Types are no longer a later extension — `dataType` and `functionPrototype` are
authored interpretation like any other edit, and accepted ones reach the
decompiler. Merge and conflict detection remain collaboration work.

## Pseudocode context menu, second pass

The earlier fix (`6fd32013d94`) taught Rename, Set Comment and Set Tags to prefer
the address the menu was opened on, but left two ways for a right-click to act on
the previously selected object.

`DecompileFunctionAction` never took the forwarded target at all: it asked
`activeListing().selectedFunctionRva()`, so right-clicking a function entry in the
pseudocode pane decompiled whatever row the listing was on. It now prefers the
menu's address, which the entry's `whenSelectionIs('function')` gate already
guarantees is an entry, and falls back to the listing only for the keybinding and
palette paths. `GenerateSignatureAction` was already correct — it parses
`requestedRva` first.

Separately, the listing's `publishSelection` was not guarded by `applyingFocus`
the way `publishFocus` is. `applyFocus` ends in `table.setSelection`, and it is
async — one address lookup per focus — so an echo still in flight when the analyst
right-clicked elsewhere landed after that click and overwrote the selection the
menu had just published. Nothing needed the echo: every surface that opens the
selection menu publishes the object under the cursor first.

Verified: client typecheck clean, 369 Delver tests passing. Both are UI paths, so
the live check — right-clicking a pseudocode line and confirming Decompile
Function follows the cursor rather than the listing — is still outstanding.

## Known limitation

Wrapped/unbounded source or pseudocode interleaving still needs a custom dynamic
list delegate. Comments deliberately remain bounded on the instruction line.

## Cross-backend function handshake (stage 1)

Delver recovers functions and so does every decompiler backend it drives, and
nothing compared the two. The disagreement was visible only where it leaked into
pseudocode: a call whose target Ghidra recovered no function at printed as
`func_0x00014001d7a0` beside `SUB_E2A0` in the same pane.

The cause was narrow. `normalize_generated_function_names` matched
`\bFUN_([0-9A-Fa-f]+)\b` and nothing else, so Ghidra's `FUN_<absolute>` became
`SUB_<rva>` while the `func_0x<absolute>` fallback passed through untouched,
carrying an absolute address into a pane where every other name is
image-relative. The worker now rewrites it to `UNDEF_<rva>` — image-relative, and
deliberately *not* `SUB_`, because collapsing the two would present an address no
function was recovered at as a function. Both rewrites still leave an address
below the image base alone.

[ADR 0017](../history/adr/0017-cross-backend-function-handshake.md) settles the
shape before a second backend arrives: Delver's set is the one reference frame,
each backend reconciles against it and nothing else. Pairwise comparison would
have been N² relationships with no principled tiebreak; this is N, and adding
IDALib is one adapter that touches no existing comparison. `reconcileFunctions`
implements the join — total over the union of entry RVAs, classifying `agree`,
`boundsDiffer`, `delverOnly` and `backendOnly`, carrying Delver's
`FunctionSource` through and deciding nothing. Adjudication is kept out of the
join on purpose: a ranking heuristic will be wrong at least once, and one that
lives in the join takes the corpus with it.

Verified: `python -m unittest test_delver_decompiler_worker` 13/13, client
typecheck clean, `scripts\test.bat --grep reconciliation` 7/7 for the new suite.

Not built, and tracked in the ledger: the `listFunctions` backend capability, the
adjudication pass, a surface that shows the reconciliation, and repair. Repair
stays gated until the reconciliation has been read on real samples — pushing an
unvalidated function set at a decompiler makes it emit confident wrong C.

## Handshake stage 2, and the defect it found

The reconciliation ran against `Auto-updater.exe` with IDA 9.1 as the second
party, and its first output was a defect in Delver rather than in a backend.
640 boundaries came back `delverOnly` from `ExceptionDirectory` — the most
authoritative source there is. 638 of them were chained `RUNTIME_FUNCTION`
fragments: `extract_exception_seeds` read `BeginAddress` and `EndAddress` and
never `UnwindInfoAddress`, so a function the compiler split across ranges
became one function per fragment, each wearing compiler-emitted authority.

Fixed. `unwind_info_flags` resolves the record and the seed is skipped when
`UNW_FLAG_CHAININFO` is set; unwind info that cannot be mapped keeps the seed
and sets `exception_directory_failed`, because a missing function start costs
more than a false one and neither may pass silently as fact. Delver's count on
that sample fell 2403 → 2113 and `delverOnly/exceptionDirectory` fell 640 → 2 —
the two that remain are real IDA misses, so the handshake reported a defect in
both directions on its first run.

The count did not fall to the 1264 real `RUNTIME_FUNCTION` entries: the linear
sweep now finds the fragment bodies itself, and `delverOnly/linearSweep` rose
183 → 528. Much less severe, and recorded unfixed in the defect audit — the
load-bearing change is that those addresses are labelled a guess instead of a
compiler-emitted fact.

ADR 0017's Consequences section has been corrected. Its first draft reasoned
that a vouched source plus `delverOnly` was evidence of a backend miss; the data
refuted that 638 times out of 640. What provenance actually buys is a shape to
investigate — a disagreement concentrated in one source is a claim about a
parser. Keeping adjudication out of the join is what made that correction cost a
paragraph.

Stage 2 landed alongside it: the worker advertises a `listFunctions` capability
and answers it from Ghidra's function manager without creating anything, and
`PyGhidraDecompiler.listFunctions` returns `undefined` when a backend does not
advertise it — the absence of an answer, never an empty one.

Verified: Rust workspace green (0 failing suites, corpus 7/7 including the new
`x64-chained-unwind`), client typecheck clean, 377 Delver TS tests passing,
worker 13/13.

Still not built: the adjudication pass, and any surface that shows a
reconciliation. Repair stays gated.

## Continuing the handshake: two more fixes, and the rule that replaced the wrong one

**The sweep regression.** Removing the fragment seeds removed their ranges too,
and the linear sweep's guard is a range — it skips addresses inside an
authoritative extent. Fragment bodies suddenly belonged to no recorded range, so
the sweep walked in and guessed starts in the middle of split functions:
`delverOnly/linearSweep` rose 183 → 528. `ParsedImage::exception_ranges` now
carries every `RUNTIME_FUNCTION` range, fragments included, and the sweep
excludes them. A fragment is compiler-declared code belonging to a function even
though its start is not a function start; dropping that with the seed was the
mistake. The sample's count fell 2113 → 1765 and the sweep figure returned to
exactly its 183 baseline. Two tests pin it, including a negative control on
identical bytes with no declared range so the guard is tied to the range rather
than to the absence of a seed.

**Validated at scale.** 26 real PEs parsed clean, no failures and no
`exception_directory_failed`. The fragment share varies enormously and the fix
matters most where it is largest: `amd_comgr_3.dll` has 204,349
`RUNTIME_FUNCTION` entries and 102,902 real function starts, so 101,447 false
functions no longer enter the analysis. Many DLLs have no fragments at all,
which is the right answer for unsplit code.

**Adjudication, on the rule the evidence actually supports.** `adjudicate`
classifies each row by **containment** rather than provenance: does the disputed
address fall strictly inside a function the other side already has? Inside is a
boundary dispute, outside a coverage gap. Across four images after the fragment
fix, every remaining exception-directory disagreement fell outside any backend
function — 23 of 23, against 638 of 640 inside beforehand. Provenance did not
separate those populations; containment does. Source concentration survives as
an advisory signal because it is what made the fragment defect legible.

Run against IDA 9.1, the pass reports what it should: `backendCoverageGap`
concentrated in `exceptionDirectory` on `advpack` and `appinfo` (genuine IDA
misses, all outside IDA functions), and on `Auto-updater.exe` a
`boundaryDispute` population of 142 concentrated in `linearSweep` — Delver's
sweep guessing inside functions IDA has, correctly labelled a guess rather than
a fact.

**Coherence fix.** `UNDEF_` had been invented inside the Python worker with no
counterpart in `naming.ts`, which owns placeholder naming — the drift invariant
14 exists to catch. It is now `placeholderUnrecoveredFunctionName`, documented
against `SUB_` and `loc_` as a third distinct claim, and `isPlaceholderName`
recognizes it, so a generated name can never be logged as one an analyst chose.

**Anchors need no migration.** Under [ADR 0015](../history/adr/0015-authored-corrections-re-derive-facts.md)
a correction is an input to the derivation: a `Define` at a fragment RVA
survives the fix and re-adds that seed, which is the analyst correctly
overruling the derivation, and an `Undefine` that now matches no seed suppresses
nothing and errors on no path. Authored names are append-only and untouched; one
at an address that is no longer an entry decorates an address rather than a
function, which is the true statement.

Verified: Rust workspace green, corpus 7/7, client typecheck clean, 385 Delver
TS tests, worker 13/13.

Still open: a split function's recorded extent stops at its first fragment
(defect audit — about half the `cdd.dll` extent disagreements fit that shape,
and the rest are unexplained), no surface shows a reconciliation, and repair
stays gated.

## Split functions are whole again

The last defect the handshake had surfaced: a function the compiler split across
several ranges kept only its first piece. `containing_function` enforces a
recorded end, so every address in a cold piece answered `None` — no owning
function for any call site, global access or listing header inside it. Measured
across five images, **every** fragment was orphaned: 638 of 638 in
`Auto-updater.exe` (113,727 bytes), 1,719 of 1,719 in `ntdll.dll` (213,596
bytes). Nothing was misattributed, which is precisely why it stayed invisible —
the analysis declined to answer rather than answering wrongly.

Fixed by following the chain rather than stretching the extent. A chained
`UNWIND_INFO` carries the primary's `RUNTIME_FUNCTION` after its unwind codes;
`resolve_chain_primary` reads it and follows nested chains up to a bound,
because the file controls where each link points and an unbounded walk is a
hang. `Function::fragments` holds the extra ranges and `containing_function`
consults them only after the contiguous answer fails, so an image with no split
functions pays one binary search as before.

Folding fragments into `end_rva` would have been the shorter fix and is wrong: a
cold piece can sit far from its entry, and one extent stretched over the gap
swallows every function in between. A test pins that case on both sides of the
wire.

`FunctionWire.fragments` carries the ranges to the workbench —
`protocol.generated.ts` regenerated from the crate, not hand-edited — and
`containingFunctionRva` mirrors the Rust rule. Both now have parallel test
cases, since the two answering differently is the failure that matters. After
the fix all five images report zero orphaned and zero misattributed fragments.

This also bore on the extent disagreements with IDA, though the reading of them
recorded here at the time was wrong — see the correction in the following
section.

## The handshake is reachable

It had been tested code with no caller. `IDelverAnalysisService.listBackendFunctions`
now crosses the shared-process boundary — `ProxyChannel` forwards by name, so no
per-method registration — and answers from the PyGhidra worker's function
manager. The headless backend returns `undefined`: it runs one function at a time
and never holds a program, so it advertises nothing and the handshake is simply
absent for it, which is not the same claim as the sets agreeing.

`delverFunctionHandshake.ts` closes the pipeline. It is where the wire's `"0x…"`
strings become `bigint` — on the renderer side of the boundary and nowhere
earlier — and it returns the reconciliation, the adjudication, and a summary
that counts each kind of disagreement separately rather than as one number.

Verified: Rust workspace green, corpus 7/7, client typecheck clean, 396 Delver
TS tests, worker 13/13.

Still not built: a trigger — a command or agent capability that runs the
handshake and somewhere to show it — and repair.

## The handshake has a trigger, and a correction

`delver_function_handshake` is a read capability on the agent surface: no
arguments, because it compares the whole image at once and naming a subset
answers a different question. It is the first caller the reconciliation has had.

Two refusals in it are the load-bearing part. A Delver function list cut short by
the response bound is refused outright rather than disclosed as partial: a
truncated set does not merely omit rows, it turns every backend function missing
from it into a "Delver missed this" row, and the disagreement *is* the output, so
a caller cannot subtract a bound from it afterwards. The test asserts the backend
is never even asked. Separately, a backend that cannot enumerate answers
`CAPABILITY_UNAVAILABLE` — the absence of a comparison, never agreement.

**Correction to what this document said last session.** The extent disagreements
with IDA were reported here as "28 of 60 explained, the residual small deltas
both ways, one real 866-byte outlier". That was measured against Delver's
*primary* end, which for a split function is where the first piece stops — not a
comparison of two extents at all. Measured against the outermost extent:

| | compared | identical | differing | largest |
| --- | --- | --- | --- | --- |
| `advpack.dll` | 334 | 333 | 1 | 3 bytes |
| `cdd.dll` | 483 | 451 | 32 | 5 bytes |
| `appinfo.dll` | 1012 | 974 | 38 | 11 bytes |

93–99.7% agree exactly and every difference is at most 11 bytes of trailing
padding. The 866-byte outlier does not exist: it is `appinfo.dll` `0xc4c0`, whose
pieces run to `0xc835` against IDA's `0xc840`, and comparing against the primary
end at `0xc4de` invented the other 855.

The lesson is about the handshake rather than about either tool. A comparison is
only as good as the question it asks, and a wrong question yields confident
numbers rather than no numbers — which is the failure mode this project ranks
worst, arrived at from the measurement side. Entry comparison was well defined on
both sides from the start; extent comparison needed the fragment model before it
meant anything.

Verified: Rust workspace green, corpus 7/7, client typecheck clean, 399 Delver TS
tests, worker 13/13.

Still not built: a surface that shows a reconciliation, and repair.

## The comparison actually runs

Driving the built workbench turned up the defect that mattered most, and it was
mine. `open_target` imports with `analyze=False` — full auto-analysis takes
minutes and pseudocode for one function does not need it — so the first live run
of the pane reported **0 of 1765 functions agreeing** against a partially
imported program. Every function Ghidra had not got to yet read as a
disagreement. Confident, plausible, and wrong, arrived at from the measurement
side rather than the parsing side.

The worker now reports `analysisComplete` from Ghidra's own `Analyzed` program
option, and a caller that cannot tell assumes the weaker thing. Refusing on that
alone was honest but left the feature permanently unavailable, so `analyzeTarget`
finishes the work on request: explicit rather than hidden inside another call,
cancellable through the same path a decompilation uses, idempotent, and marking
the program analyzed afterwards because `analyzeAll` does not do it itself.

With analysis complete the pane answers for real, against `Auto-updater.exe`:

```
1007 of 1765 functions agree      vs ghidra-pyghidra (1550 functions)
Only Delver found these      82 — mostly guess
Only the backend found these  9
Split differently           142 — mostly guess
Bounded differently         534
```

Worth putting beside the IDA 9.1 numbers measured offline — 1040 agree, 540
bounded differently, 11 backend-only, out of 1591. Two independent backends land
within a few percent of each other on every count, which is the cross-backend
signal ADR 0017 predicted would be available without ever plumbing the backends
together. And both concentrations now read *mostly guess*: where Delver differs
from a real analyzer, it is overwhelmingly on its own unvouched boundaries, which
is exactly where it should be.

The view is a navigator surface named **Comparison** — one word, because
"Backend Comparison" truncated to "Backer" in the segment strip, which reads as
a different word. Verified in the running workbench: the segment fits at 71px
beside References at 65 and Signatures at 63, groups expand, and rows navigate.

Verified: Rust workspace green, corpus 7/7, client typecheck clean, 406 Delver TS
tests, worker 13/13, plus a live end-to-end run against a real Ghidra backend.

Still not built: repair.

## What the original report actually was

The thread began with `uVar5 = func_0x00014001d7a0(param_1)` in a pseudocode
pane. Rewriting that to `UNDEF_1D7A0` made it image-relative and honest, and it
was never the cause.

Driving the worker directly, no UI in the way: before `analyzeTarget`, Ghidra
held 1265 functions and `SUB_E2A0` decompiled with **26** `UNDEF_` placeholders;
after, 1550 functions and **zero**. Every placeholder was a call whose target
Ghidra simply had not recovered yet, because `open_target` imports with
`analyze=False`.

The comment justifying that says analysis "can take minutes even for small
installer-style binaries". Measured on a warm worker it is 22s for the 764 KB
sample and 30s for a 2.5 MB `ntdll.dll`, once per content hash because the
analyzed program is cached.

**Raised rather than changed.** On-demand recovery is a recorded decision, and
the choice between a fast first F5 with placeholders and a slower one with
complete pseudocode is a product call. The current behaviour is unhelpful, not
wrong — `UNDEF_` states exactly what is true. What landed is the means to
choose: `Delver: Analyze Target in Decompiler Backend` on the palette, with
progress and cancellation, so an analyst who sees placeholders can resolve them
deliberately. The recommendation and its numbers are in the defect audit.

Also measured and declined: the linear sweep decodes jump tables as functions —
`SUB_D940`, `SUB_D94C`, `SUB_D950` four bytes apart are entries in a table of
RVAs at `0xd940`. Twelve such addresses on this sample and nine on `aadtb.dll`,
zero on four other images. Too rare to pay for a recovery change, and the cheap
rules cost more than they save: 225 of the sample's 244 swept functions have no
incoming reference at all, which is exactly the code the sweep exists to find.

Verified: client typecheck clean, 406 Delver TS tests, worker 13/13.

## Repair is declined, and ADR 0017 is closed

The last unbuilt piece of the handshake was repair: push Delver's vouched
boundaries into the backend so a call with no recovered function gets a real
name. It was gated on reading the reconciliation against real samples first. It
has been read, and the answer is that there is nothing to push.

Against a *fully analyzed* Ghidra program:

| | Delver | backend | backend coverage gaps | of which vouched |
| --- | --- | --- | --- | --- |
| `Auto-updater.exe` | 1765 | 1550 | 82 | **0** |
| `appinfo.dll` | 1274 | 1269 | 8 | **0** |

Every boundary the backend lacks is one Delver reached by linear sweep — its own
guess, twelve of them jump-table entries. The vouched set to push is empty, and
pushing the rest would ask a decompiler to create functions at addresses nothing
vouches for, which is exactly the outcome the gate existed to prevent.

The gap repair was designed to close was an artifact of *when* the backend was
asked, not of what it can find. ADR 0017 is amended with the numbers and the
feature is marked done with repair recorded as deliberately skipped — if a
backend ever does miss vouched boundaries after full analysis, the
reconciliation is what will show it, and the decision is worth reopening with
that backend's numbers.

Verified: Rust workspace green, corpus 7/7, client typecheck clean, 406 Delver
TS tests, worker 13/13.
