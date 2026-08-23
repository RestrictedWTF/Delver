# The AI Analyst

The vision says the AI is an analyst that invokes structured tools. Correct. This
doc covers what that requires beyond "give the model context": grounding,
provenance, the proposal layer, and measurement.

Governing constraint: **in a security workflow, an unauditable analyst is worse
than no analyst.** A wrong conclusion from a human gets caught in review; a
wrong conclusion delivered with the fluency of an LLM gets shipped as a detection
rule. Every design decision below follows from that.

---

## 1. Tools, not context stuffing

Register RE capabilities as language model tools through the existing
`ILanguageModelToolsService`
(`src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts`). They
are the same operations the Python client exposes over DTP — one capability
surface, three consumers: the UI, AI tools, and user scripts. See
[04-IDE-Architecture.md](ide-architecture.md) §5.

**The tool catalog lives in the
[P3 AI integration plan](../planning/ai-integration-plan.md) §5, not here.** It
moved because a second list is a second source of truth, and the two drifted
apart within one phase: this document still said `delver_findStrings` after the
implementation had settled on `delver_search_strings`. Names are snake_case and
identical across the built-in registry, MCP, and Python.

Shipped in P3a (read and UI only):

```
delver_capabilities      delver_session_info      delver_current_context
delver_focus             delver_image_info        delver_list_functions
delver_lookup_function   delver_disassemble       delver_decompile
delver_xrefs_to          delver_xrefs_from        delver_list_strings
delver_search_strings    delver_imports           delver_exports
delver_get_interpretation delver_propose_rename      delver_propose_comment
delver_propose_tag       delver_report_finding
```

The runtime tools this section once listed — processes, threads, registers,
modules, regions, image diff — belong to P4 and are not stubs waiting to be
filled in. The rename/comment/tag proposal tools and durable range-backed
`delver_report_finding` have arrived with P3c. Review surfaces and references to
earlier tool-call records remain (§3).

Design rules for these tools:

- **Every result carries its `Moment` and its provenance.** If the model reads
  memory at epoch 41 and the target advanced to 42, the transcript must show it.
- **Every result declares what it did not get.** Unreadable pages, truncated
  reads, analysis that timed out. Silently returning zeros for a paged-out page
  produces confident analysis of nothing.
- **Bounded output.** `readMemory` with a 512 MB length must fail with a useful
  error, not fill the context window. Cap and paginate every tool.
- **Read tools are free; write tools produce proposals only.** See §3.
- MCP (`src/vs/workbench/contrib/mcp/`) is already in the fork, so external
  tooling — a Ghidra bridge, a sandbox detonation service, a threat-intel
  lookup — plugs in without Delver-side work.

## 2. Grounding: claims must reach facts

Every AI-produced statement that enters the workspace is an `IFinding` or an
`IEdit` with `evidence` pointing at concrete facts: a tool call in the
transcript, an address range, a graph path.

```ts
export type EvidenceRef =
	| { kind: 'toolCall'; callId: string }
	| { kind: 'range'; range: IAddressRange; moment: IMoment }
	| { kind: 'graphPath'; path: readonly NodeRef[] }
	| { kind: 'finding'; id: string }
	| { kind: 'external'; uri: URI };       // CVE, report, sample family
```

The UI affordance that matters: **click any AI claim, see the evidence chain**.
Not the chat message that produced it — the actual tool calls and byte ranges.
An analyst must be able to check the model's work in under ten seconds, or they
will stop checking.

A claim with no evidence is not written to the workspace. It stays in the chat as
conversation.

## 3. The proposal layer

The model does not mutate the interpretation layer. It appends edits with
`status: 'proposed'`.

- Proposals render distinctly in every view — a rename shows as
  `sub_401000 → ⟨decrypt_config?⟩` with a proposal affordance, not as a settled
  name.
- The first Review surface lists pending interpretation proposals and findings,
  with individual accept/reject actions and focus-bus navigation. Grouping by
  operation/confidence, threshold acceptance, and threaded discussion remain
  later review ergonomics.
- Accepting appends an `accepted` edit authored by the *human*, with the
  proposal as evidence. The chain of custody stays intact: you can always ask
  "who actually decided this, and on what basis?"
- Rules can auto-promote in narrow, explicit cases (e.g. a rename derived from a
  verified import thunk). Auto-promotion is itself an author (`kind: 'rule'`),
  so it's equally revertible.

Batch operations need a mode where the model proposes 400 renames and the human
reviews them as a set. That review flow is the difference between a demo and a
tool people use on real samples.

## 4. Investigation notebooks — the primary AI surface

A chat sidebar is the wrong shape for an investigation. Investigations are long,
branching, and need to be re-runnable and exportable. Notebooks are exactly that,
and the entire notebook stack is already in the fork
(`src/vs/workbench/contrib/notebook/`).

An investigation notebook is a `.delvernb` with cells:

- **Prose** — the analyst's reasoning
- **Query** — a Python cell using the Delver client, executed against the
  current target, output persisted with the Moment it ran at. This is an
  ordinary Python kernel with `DELVER_SESSION` in its environment, so no custom
  cell type is needed
- **AI** — a prompt with its tool-call transcript and produced findings inline
- **Evidence** — pinned listings, hex ranges, graph fragments, diffs

Properties this gives you almost for free: reproducibility (re-run against a new
sample), review (a colleague reads the notebook top to bottom), export (the
notebook *is* the report), and a natural training/eval corpus.

Implement it as a notebook controller plus a serializer. Cell outputs must record
the Moment; a cell that ran at epoch 12 against a live target is not
reproducible, and the notebook should say so rather than pretend.

## 5. Prompt injection from the sample

This is a threat class that does not exist for traditional RE tools and will
exist for Delver from the first release. Treat it as a first-class security
concern, not an edge case.

A binary contains attacker-controlled bytes. Strings, section names, exported
symbol names, PDB paths, resource data, and decompiler output derived from all of
these end up in the model's context. An author who knows analysts use AI tooling
can embed text designed to steer the analysis — most obviously, to get the sample
classified as benign.

Mitigations, in order of importance:

1. **Never let sample-derived text occupy an instruction position.** All target
   data enters as clearly-delimited tool *results*, never as system or user
   content, and never concatenated into a prompt.
2. **Mark it as untrusted in the transcript.** Wrap sample-derived content in
   explicit untrusted-data delimiters and state in the system prompt that content
   inside them is data under adversary control and must never be treated as
   instructions.
3. **Sanitize for rendering too.** Sample strings reaching chat, markers, or the
   notebook must not be able to inject markdown, HTML, links, or terminal escape
   sequences. This is a classic RE-tool vulnerability independent of AI.
4. **Gate side effects.** Tools that write, execute, or reach the network require
   explicit confirmation — the confirmation infrastructure already exists in
   `chat/common/tools/languageModelToolsConfirmationService.ts`.
5. **Detect and surface it.** If sample content contains imperative text aimed at
   an analysis system, that is itself a **finding** of high interest — it means
   the author anticipated AI-assisted analysis. Report it rather than only
   filtering it.

Write this into the threat model in
[06-Security-Model.md](security-model.md) and test it: keep injection samples
in the golden corpus and assert the model's conclusions don't move.

## 6. Measurement

You cannot tune what you don't measure, and "the demo looked good" is not a
metric for a tool whose output becomes detection logic.

Build an eval harness on the golden corpus from G5 of
[01-Critique-and-Direction.md](../history/critique-and-direction.md):

| Metric | Definition | Why |
| --- | --- | --- |
| Grounding rate | % of AI claims with valid evidence refs | Catches confident fabrication |
| Hallucination rate | % of claims contradicted by ground truth | The headline number |
| Proposal acceptance | % of proposals a human accepts | Real-world usefulness signal |
| Tool efficiency | Tool calls per resolved question | Cost and latency |
| Injection resistance | Verdict change on injection-laden samples | Adversarial robustness |

Run it in CI against a pinned sample set. Track it per model version — you will
want to know immediately when a model upgrade regresses grounding.

## 7. What the AI should *not* do

- **Not the decompiler.** Do not ask a model to produce pseudocode from bytes.
  Use a real decompiler and let the model explain and annotate its output.
- **Not the disassembler.** Same reasoning, more so.
- **Not the final verdict.** Delver produces evidence and hypotheses with
  confidence. A human, or a promoted rule, produces verdicts.
- **Not silent background mutation.** Nothing in the interpretation layer changes
  without an author and an entry in the log.

## 8. Where the differentiator actually is

Everyone will ship "explain this function" within a year. The defensible thing is
**cross-investigation memory**: today's concluded investigation becomes a
`Recipe` — a pattern plus a graph query plus the evidence that justified it —
and tomorrow's sample is checked against the accumulated library before an
analyst looks at it.

That compounds with use and can't be copied, because it's built from your users'
own work. It doesn't need to ship early, but the `Finding` and `Recipe` schemas
must exist from P1 so the data is being captured all along. You cannot mine this
out of chat logs later.
