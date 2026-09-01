# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/). For what is *wrong*
with what exists, see [defect-audit.md](defect-audit.md) — a full read of the
codebase on 2026-08-26, ranked, with the fixed rows deleted as they land.

---

**Last updated:** 2026-09-01
**Current phase:** P3c/P3d — reviewed evidence plus static-analysis depth (P3b client conformance and P3a/P2b real-project smoke continue alongside)

Everything older than the entries below is in
[development-log-2026-08.md](../history/development-log-2026-08.md) — the August
working notes, verbatim and unmaintained. Read it only when you need the
reasoning behind something, not to find out where things stand.

## Just landed — a six-way audit, and twelve defects closed

A full audit on 2026-09-01 (docs against code, dead surface, blocked-item
dependency map, analyst journeys, test coverage, roadmap direction) found the
codebase lean — about 1.7% dead — and the recurring failure to be **work that
stops one inch short of a user**. The cause was structural: invariant 15 barred a
session from driving a workbench, so any feature whose last step was a UI, a
package or a human entry point could not be finished by whoever built it.
[ADR 0020](../history/adr/0020-the-model-drives-the-workbench-to-verify-behaviour.md)
split that rule along behaviour versus appearance.

Closed since: three dead UI clicks, human type authoring, parse-completeness
rendering, packaged decompilation, declaration validation and placement parity,
a call target admitted at an impossible RVA, exported data symbols seeded as
functions, 5,622 phantom exports, a web build registering surfaces with nothing
behind them, and 866 lines of `entry_role.rs` that resolved 0 of 80 binaries.
CI now gates the TypeScript suite, which had never gated a commit, and clippy
runs at `-D warnings`.

Driving the UI immediately found two defects nothing else could — a command that
threw on every invocation while 427 tests passed, and a function reported at
`0xFFFFFFFFEA160702`. The full narrative is in
[the development log](../history/development-log-2026-08.md); the ranked list of
what is still wrong is [defect-audit.md](defect-audit.md), rows 46-60.

**Open and worth knowing:** [ADR 0021](../history/adr/0021-the-provider-issues-the-moment.md)
is `proposed` and needs a yes or no — invariant 1 holds below the process
boundary and not above it until it lands. The proposal -> review -> accept loop
still has no exercise path that is neither a model nor a human.

## The review loop has been driven, and it works

I had recorded that the proposal -> review -> accept loop "has no exercise path
that is neither a model nor a human". That was wrong, and `delver-mcp` is the
path. Connected as an MCP client over stdio against a window opened on a
workspace folder:

- **41 tools**, not the three a test fixture in `delver-mcp/src/backend.rs`
  suggested — `list_tools` returns whatever the window's catalog holds.
- `delver_image_info` returned live facts for the open project.
- `delver_propose_rename` created a proposal, and it appeared in the Review
  surface as `Rename 0x1010 to mcp_verified_rename`, attributed to
  `dtp:delver-mcp` with `kind: model`, with the segment badging `Review · 1`.
  That is the attribution the whole moat rests on, working.
- Schema validation is strict and fails closed: an extra `rationale` field was
  refused by name.

Two things stopped the accept, and neither is the security design I assumed:
the accept action is hover-only inline UI that CDP could not trigger, and a
second client could not reconnect (**#62** — every later attempt returned
`no Delver window matches the requested root`, undiagnosed). Binding a key to
`delver.review.acceptAll` instead surfaced **#61**: four review commands
dereference `handle.$treeItemHandle` unguarded and throw a raw `TypeError`
when invoked from any path but the view menu.

**An eval harness driven over MCP is therefore viable**, and is the cheapest
route to measuring which of the 41 capabilities an agent actually calls.

## Where to pick up

- **Local variable naming needs a durable identity design** before any of its
  plumbing. That is the largest remaining gap in the reading workflow and it is
  a design question, not a build one.
- **The type-system row continues**: local variables and stack frames, and type
  propagation. Unions and enums are off it.
- **Merge and conflict detection** remain collaboration work, untouched.
- **Discontiguous pseudocode selection painting** is still the next UI-side P2
  slice. Wrapped or unbounded source and pseudocode interleaving still needs a
  custom dynamic list delegate.
- **Indirect call resolution's weaker half is blocked on type recovery, not on
  vtables.** Vtables landed; they are not the missing input, and this line
  previously said they were. A slot says class `C` dispatches `F` at index `N`,
  which resolves `call [rax+0x18]` only if something establishes the object's
  type at the site — so a resolver built now would pick a class and label the
  guess as evidence. `delver_call_graph` and `delver_call_paths` report
  `partial` exactly when a call site is left unresolved — a graph whose every
  indirect site resolves to a named import already reports `complete` — so an
  unresolved virtual dispatch is what keeps one partial until an *exact*
  virtual resolution exists.
  [The analysis](ideas/probable-indirect-call-resolution.md) recommends
  constructor vptr-write typing as the thing that unblocks it, and names two
  read-only measurements that would overturn it.
- **Compiler-metadata recovery: the vtable slice is started, the rest is not.**
  Hierarchy descriptors, virtual inheritance and demangling are still P5 and
  still unmeasured. Nothing consumes the recovered slots yet — wiring them into
  the `probable` indirect-call tier is separate work.

Live checks are outstanding wherever a change was only unit-verified; the UI
paths in particular were reasoned about, not driven.
