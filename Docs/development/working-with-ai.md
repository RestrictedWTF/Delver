# Working With AI on Delver

How the repo is set up so AI-assisted development stays coherent across a
multi-year project, without spending the session on verification ceremony.

**Assumption:** the human verifies — compiling, running, testing, reviewing.
Nothing here asks the model to prove its own work. What it does ask for is that
**decisions and state are written down**, because that's the thing a cold session
cannot reconstruct and the human shouldn't have to re-explain.

---

## 1. The actual failure mode

Not bad code. **Silent architectural drift.**

A session needs a decision — how anchors rebase, whether xrefs live in the fact
store or the graph, what happens on a partial read. The decision exists, but not
anywhere the model can find it. So the model makes a reasonable, different one
and doesn't flag it. Six of those and two subsystems disagree about what an
address is.

Three defenses, in order of leverage:

1. **Invariants in `CLAUDE.md`** — the short list of things a fresh model gets
   wrong, loaded every session.
2. **Lint rules** — enforcement beats convention, because the model gets the
   feedback itself instead of you catching it in review.
3. **Written decisions** — ADRs, so a revisit starts from the original reasoning.

Everything else in this doc is secondary to those three.

---

## 2. Three records, three jobs

Conflating these is the usual mistake. They answer different questions.

| Record | Question it answers | Changes | Cost |
| --- | --- | --- | --- |
| [`adr/`](../history/adr/) | *Why is it this way?* | Append-only; superseded, never edited | Rare — maybe 20 over the project |
| [`LEDGER.md`](../planning/ledger.md) | *What exists, what's stubbed, what did we skip?* | One row per feature | Per feature |
| [`STATUS.md`](../planning/status.md) | *Where were we?* | Overwritten | ~30 seconds per session |

### ADRs — for revisiting

Only for decisions that are expensive to reverse: disassembler engine,
decompiler backend, storage format, transport, the Python-vs-TypeScript
scripting call. One page. When you change your mind, write a new ADR that
supersedes the old one — **never edit the original**, because the value is in
seeing what you believed at the time and what changed.

The docs in [`../architecture/`](../architecture/) are the *current standing design*. ADRs record
movement away from them.

### LEDGER — for skipping and falling back

The direct answer to "skip or improve any feature at any point with the required
context." One row per feature: phase, status, where the code is, **what was
deliberately not done**, and the ADR if there was a real decision.

That "deliberately not done" column is the load-bearing one. Six months later
the question is never "does this work" — it's "did we skip this on purpose, and
what did we know then?"

### STATUS — for cold starts

Current phase, what's in flight and where, what's known-broken, next few things.
Overwritten each session. This is the single cheapest high-value habit: one write
at the end of a session turns the next cold start into a warm one.

---

## 3. Fallback is structural, not procedural

Worth knowing because it shapes how features get built:

**One contrib = one import line in `workbench.common.main.ts`.** Removing a
feature is deleting that line. The structure from
[08-Project-Structure.md](../architecture/project-structure.md) is already the fallback
mechanism — you don't need a process for it.

For things you want shipped but off, use `IConfigurationService` flags under
`delver.experimental.*` rather than branches. A long-lived feature branch on a
fork that also tracks upstream is a merge problem twice over.

So: **build every feature as a removable contrib**, and "fall back" is a
one-line revert plus a LEDGER status change.

---

## 4. Invariants belong in `CLAUDE.md`

`CLAUDE.md` loads every session, so it's expensive real estate — it should hold
only what's needed *every* time. Not architecture (that's `Docs/`), not history
(that's ADRs). Just the list of things a fresh model will get wrong.

Delver's lives in the **root `CLAUDE.md`** — a new file, zero merge surface. The
upstream VS Code one at `.claude/CLAUDE.md` stays untouched.

Keep it under ~80 lines. When it grows past that, the excess belongs in a doc
with a pointer from the invariants list.

---

## 5. Enforcement over convention — the highest-leverage item

**A convention the model can violate silently is a convention that will be
violated.** A lint rule gives it immediate feedback without you in the loop.

This repo already has custom-rule infrastructure at `.eslint-plugin-local/`
(see `code-layering.ts`, `code-import-patterns.ts`, `code-no-any-casts.ts` for
the pattern). Adding rules there is cheap and it's the best money you'll spend.

Worth writing, roughly in priority order:

| Rule | Catches |
| --- | --- |
| `delver-no-target-kind-branch` | Any comparison against `descriptor.kind` — the capability-model violation from [03](../architecture/target-providers.md) §1 |
| `delver-address-is-bigint` | Params/fields named `addr`/`address`/`rva` typed `number` |
| `delver-require-moment` | `read*`/`list*` on a Delver service without an `IMoment` param |
| `delver-no-generated-edit` | Imports or edits reaching into `*.generated.ts` |
| `delver-no-cross-contrib` | Configure the existing `code-import-patterns` — no new rule needed |

Rust side, in every crate root: `#![deny(warnings)]` in CI, `clippy -D warnings`,
and `#![forbid(unsafe_code)]` everywhere except `provider-winproc`.

Each rule is maybe 40 lines and permanently removes a class of drift.

---

## 6. Skills for repetitive multi-file work

Project skills in `.claude/skills/`. The right candidates are operations that
span several files in a fixed sequence, where doing half of it leaves the repo
subtly broken:

- **`add-contrib`** — contribution file, editor input/pane if applicable,
  registration line, media folder, test folder, naming per
  [08](../architecture/project-structure.md) §7.
- **`add-protocol-method`** — Rust `delver-protocol` type, regenerate schema,
  regenerate TS, implement both sides, bump the version. Easy to do four of five
  steps.
- **`add-capability`** — enum, provider advertisement, context key, `when`
  clauses.

Don't write skills for things that happen twice. Write them when you notice
yourself explaining the same sequence a third time.

---

## 7. What not to automate

The model verifies its own work, but that is not an argument for verifying on
every edit. Concretely, **do not** add hooks that run builds, typechecks, or test
suites on write — they are slow and noisy, and they fire on half-finished states
where a failure means nothing. Verification belongs at the end of a change, run
deliberately, by whoever finished it.

What stays the human's is anything needing a workbench, a rendered DOM, or an
eye: launching Code OSS, driving the UI, judging how something looks. Those are
faster done by hand than described, and a model reporting that a pane "looks
right" is reporting nothing.

Two hooks *are* worth it, because they're instant and serve codebase cleanliness
directly:

- **Format on write** — `rustfmt` for `.rs`, `eslint --fix` for `.ts`.
  Milliseconds, and it removes an entire category of review noise.
- Optionally, a session-end nudge to update `STATUS.md`.

The distinction: **automate cheap cleanliness, not expensive verification.**

---

## 8. Selecting the Delver test suites

`scripts\test.bat --grep Delver` **does not run the Delver tests.** Six suites
are named for what they test rather than for the product, so the filter skips
them silently — a skipped suite and a passing suite look identical in the output:

`GhidraDecompilerProtocol`, `GhidraHeadlessDecompiler`, `PyGhidraDecompiler`,
`DecompilerWorkerHost`, `InterpretationLog`, `provider exit escalation`.

The invocation that runs all of them:

```
scripts\test.bat --grep "Delver|Ghidra|InterpretationLog|DecompilerWorkerHost|provider exit escalation|PyGhidra"
```

What the short filter cost, concretely: a semantic-snapshot normalization bumped
v1 to v2 and left `GhidraDecompilerProtocol › decodes a canonical accepted
semantic snapshot` asserting the old shape. It stayed red for hours across
several "green" verifications, because the suite it lives in was never selected.
Every "N passing" figure recorded in `status.md` after that landed was counting a
subset and reporting it as the whole.

Two habits follow. **Name a suite after the product where you can** — a suite
called `DelverGhidraDecompilerProtocol` cannot be missed this way. And when a
count in `status.md` drops or fails to grow after new tests landed, suspect the
filter before suspecting the tests.

---

## 9. The golden corpus is your regression net

The corpus from P1 does double duty. It catches AI-introduced regressions that a
targeted test run would not think to look for — you run `npm run delver:corpus`
when you feel like it, and a snapshot diff tells you what moved.

It is the backstop behind self-verification rather than a substitute for it: a
model runs the tests it knows about, and the corpus is what notices the thing
nobody wrote a test for. Cheap, batched, and yours.

---

## 10. Sizing work

- **One change = one vertical slice that compiles.** Not "the listing editor" —
  "listing editor renders static rows from a fake data source." Big horizontal
  layers are where drift hides, because nothing exercises them until much later.
- **Write the interface first**, in a doc or a stub file, then have the model
  fill it in. Interfaces are where the expensive mistakes live and where your
  review time is best spent.
- **Point at the doc, don't re-explain it.** "Per `03-Target-Providers.md` §2,
  implement `provider-file`" beats a paragraph of restated context — and it keeps
  the doc authoritative instead of letting chat become a second source of truth.
- **If a decision isn't in `Docs/`, it should get raised, not invented.** That's
  the one rule that prevents drift, and it's in the invariants list.

---

## 11. Context hygiene

- Don't load all of `Docs/` every session. `CLAUDE.md` invariants plus
  [`README.md`](../README.md)'s index is the default; specific docs on demand.
- Keep files small. Easier to write correctly, easier to review, cheaper to
  reload.
- When a session's conclusion changes the design, **update the doc in the same
  session.** A design doc that lags the code is worse than no doc, because it
  actively misleads the next cold start.

---

## 12. Setup checklist

- [ ] Root `CLAUDE.md` with the invariants list
- [ ] `Docs/STATUS.md`, `Docs/LEDGER.md`, `Docs/adr/` created
- [ ] Format-on-write hooks (`rustfmt`, `eslint --fix`)
- [ ] `delver-no-target-kind-branch` and `delver-address-is-bigint` lint rules
      (before the first provider lands — they're cheap and they're the two that
      matter most early)
- [ ] Golden corpus runner wired to `npm run delver:corpus`
- [ ] `add-contrib` skill, once there are two contribs to compare
