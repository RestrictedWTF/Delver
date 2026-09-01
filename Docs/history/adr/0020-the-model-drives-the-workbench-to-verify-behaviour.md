# 0020 — The model drives the workbench to verify behaviour; the human judges how it looks

**Status:** accepted
**Date:** 2026-09-01
**Affects:** `CLAUDE.md` invariant 15 ·
[`development/working-with-ai.md`](../../development/working-with-ai.md) §7 ·
[`planning/defect-audit.md`](../../planning/defect-audit.md) #46, #48, #49, #50

## Context

Invariant 15 and §7 split verification by *tool*: the model runs builds,
typechecks and test suites, and "anything needing a workbench, a rendered DOM, or
an eye" stays the human's — launching Code OSS, driving the UI, judging how
something looks.

The reasoning was sound and one clause of it still is. A model reporting that a
pane "looks right" is reporting nothing. But the rule bundles three different
activities under one prohibition, and only the third is actually about taste:

| Activity | Is it taste? | Can a model do it? |
| --- | --- | --- |
| Launching Code OSS | No | Yes — `.claude/skills/launch/` |
| Driving the UI to see whether a thing happens | No | Yes — CDP over `@playwright/cli` |
| Judging whether it looks right | **Yes** | No |

Six months of work under the bundled rule produced a measurable pattern. A
six-way audit on 2026-09-01 found four defects that share one shape:

- **#46** — three shipped UI actions are no-ops. `IViewsService.openView` is
  called on view ids registered `when: false`, which no container's view model
  holds. The Overview's "Functions" and "References" rows and both
  signature-reveal paths do nothing when clicked.
- **#48** — a packaged build cannot decompile; nothing under `build/` stages
  `scripts/ghidra`.
- **#49** — an analyst cannot author a type. The apply path is complete and
  reachable only by a model proposal.
- **#50** — fourteen parse-completeness flags reach TypeScript and are rendered
  by nothing, so a truncated import table looks identical to a complete one.

None is a bug of the kind the three previous defect passes hunted for. There is
no wrong answer, no leak, no swallowed error, and **every file involved is
individually correct**. A read of the code cannot find them; a name-grep cannot
either, because each symbol is referenced. They are visible only by tracing a
path to a user — which is precisely what the rule put out of reach of the
sessions doing the building.

The second-order effect is larger than the defects. Work that a session cannot
finish is work a session avoids starting. Given a rule that terminates every
UI-touching feature at "wired, unit-tested, live checks outstanding", sessions
select the work they *can* close: analysis passes, protocol plumbing, agent
capabilities, documentation. That is a fair description of what exists — 41
agent capabilities and an excellent facts layer against twenty simultaneously
open `wip` ledger rows, most of them stalled one step from a human. The last
line of `status.md` has been "live checks are outstanding" for months, and that
is the rule working as written rather than anyone failing to follow it.

## Decision

**Split the rule along the axis that actually matters: behaviour versus
appearance.**

The model may launch Code OSS and drive it to establish **what happens** —
whether a command is reachable, a click has an effect, a view populates, an
error surfaces, a round-trip persists. The model reports what it observed.

The human judges **how it looks** — spacing, hierarchy, weight, density, whether
a surface reads as calm or noisy, whether an interaction feels right. A model's
opinion on that is worth nothing and this ADR does not ask for one.

The line is not "did you use a browser" but "is the claim falsifiable by
observation". *"Clicking Functions in the Overview reveals the functions
surface"* is falsifiable and the model must verify it rather than reason about
it. *"The Overview reads clearly"* is not, and stays with the human.

Three constraints keep this from becoming its own failure mode:

- **Driving is verification, not exploration.** It runs at the end of a change,
  against a specific claim, exactly as `working-with-ai.md` §7 already requires
  of builds and tests. It is not a hook and not a per-edit step.
- **An observation is reported as an observation.** "I clicked X and the
  functions surface appeared" is a fact. "The UI works" is not, and is the shape
  of claim this project already refuses elsewhere.
- **A driven check does not replace a test.** If the behaviour can be asserted
  in a unit test, it must be — driving proves the wiring reaches a user, which
  is the part a fake-service test cannot reach. Defect #46 is the case in point:
  a test asserting `openView` was called would have passed throughout.

## Consequences

The "live checks outstanding" backlog stops being permanent, and the four
last-inch defects above become closeable by the sessions that created them.

The immediate cost is honest: a workbench launch takes about ninety seconds plus
a build, so this is worth doing for a behavioural claim and not for a typo fix.
The rule's original economics — "faster done by hand than described" — remain
true for a human sitting at the machine and stop being true when nobody is.

The risk this accepts is a model over-reporting from a driven session — treating
"the pane rendered" as "the feature works", or sliding from observation into
aesthetic judgement it was told not to make. That risk is the same one the
project already manages everywhere else by requiring evidence for claims, and
the mitigation is the same: say what was done and what was observed, and let the
observation be checkable.

What does **not** change: the human still decides whether a surface is good.
Nothing here licenses a model to redesign a view because it drove it once.

## Alternatives

| Option | Why not |
| --- | --- |
| Keep the rule; the human clears the backlog | The status quo, and it is the thing being fixed. It is not that the human is unwilling — it is that UI verification is the single throughput-limited resource, and sessions keep starting UI-adjacent features faster than it can be spent. Twenty open `wip` rows is that arithmetic |
| Keep the rule and stop starting UI features | Coherent, and strictly worse: it concedes that the differentiating half of the product — review, evidence, authoring surfaces — cannot be built, leaving the commodity half that a person already has from IDA plus a chat window |
| Let the model judge appearance too | Rejected for the original reason, which was right. A model reporting a pane "looks right" reports nothing, and the failure would be invisible rather than merely wrong |
| Write UI integration tests instead | Worth doing and does not substitute. Every current TypeScript test uses a fake analysis service, a fake decompiler and a fake project store; none spawns the real server. A test suite built on fakes cannot find a defect whose whole nature is that the real layers do not meet |
