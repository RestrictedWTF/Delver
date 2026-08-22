# Stage G — The workspace panes

**Status:** complete; requested follow-ups tracked separately below
**Date:** 2026-08-07

## The problem

The Delver container has two panes: Sections and References. References is empty
until you select something, and Sections is a list of hex with no meaning
attached. Opening a binary tells you almost nothing about it.

That is not a polish problem. **The panes that carry the actual analysis do not
exist yet** — imports, exports, functions, strings. All of that data is already
parsed and already crossing DTP; none of it has a surface. The backend ran ahead
of the interface and the gap is now the whole experience.

## The principle

**Every pane is a navigation surface.** Clicking anything anywhere moves the
focus bus, and every other view follows. That is what makes seven lists feel like
one tool instead of seven lists — and it is already built, so each new pane
inherits it for free.

Second: **a pane must say something before you interact with it.** Sections shows
raw offsets; it should show what a section *is* — executable, writable, how big,
how unusual. References is empty on open; it should say what it is waiting for.

## Layout

Seven panes is too many to stack, but the Debug container is the precedent —
Variables, Watch, Call Stack, Breakpoints — and it works because panes collapse
and most stay closed. Same approach here, with deliberate defaults:

| Pane | Default | Why |
| --- | --- | --- |
| Overview | expanded | Answers "what am I looking at" in one glance |
| Functions | expanded | The primary navigation surface |
| Imports | expanded | First thing anyone checks on an unknown binary |
| Exports | collapsed | Only interesting for libraries |
| Strings | collapsed | Long; used on demand |
| Sections | collapsed | Structural, consulted rather than browsed |
| References | expanded | Follows the cursor, so it must be visible |

Container-level actions (**Open Target**, **Reset Views**) move to the container
title bar, so they are reachable without the command palette.

## Steps

Ordered by value per unit of work. Each is independently shippable.

### G1 · Imports — **done**

Tree: module → symbol. For triage this is the highest-signal pane in the tool —
`VirtualAlloc`, `CreateRemoteThread`, `WinHttpOpen` in one glance says more than
a thousand instructions. Clicking a symbol navigates to its thunk.

`getImports` already exists on the provider; it needs exposing through
`IDelverAnalysisService` alongside `imageInfo`.

### G2 · Functions — **done**

The primary navigation surface, and what makes Go to Function's quick pick
redundant as a *browsing* tool. Must be virtualized: a large module yields
~178k entries, so this is a list widget with a filter box, not a tree.

Authoritative and swept boundaries must render differently — that rule is why
the analysis carries the distinction at all.

### G3 · Overview — **done**

Architecture, entry point, image base, size, and the counts already returned by
`openImage`. Cheap, and it removes the "did anything even load" question.

### G4 · Exports — **done**

Flat list, click to navigate. Trivial once G1 has established the shape.

### G5 · Strings — **done**

The 200k cap is kept — it is a real defence against a hostile file turning
string extraction into an allocation attack — but it now **reports itself**.
`StringsResult` carries `truncated`, and the pane says which limit it hit: the
scan cap, or its own display cap of 2,000. A strings pane silently missing
entries is worse than none, because a search that finds nothing then means
nothing.

The editor page now has a persistent filter box and a dedicated encoding column.

### G6 · Polish — **partly done**

Done:

- Icons per row kind across every pane.
- Welcome content on every pane.
- **Section permissions and entropy.** `SectionWire` now carries `readable`,
  `writable`, `executable`, and Shannon entropy of the raw bytes. A section that
  is writable *and* executable, or executable with entropy above 7.0, is flagged
  — the first because compilers do not emit it and packers need it, the second
  because compiled instructions are not that random unless something has
  compressed them. Surfaced as a flag with a reason in the tooltip, never as a
  verdict: a section full of compressed resources trips the same test.
- Container title actions for Open Target and Reset Views.
- Persistent filter boxes on Functions and Imports. The Strings editor page has
  its own filter and encoding column. A zero-match query stays in the ordinary
  tree body rather than activating welcome content, so its filter remains
  reachable and recoverable. Search-only root identities keep automatic filter
  expansion from changing the unfiltered tree's expansion state.
- Every function remains reachable. Because `TreeView.getChildren` materializes
  its returned array even though DOM rows are virtualized, large categories are
  split into lazy 1,000-item pages. A 178k-function image therefore creates about
  178 cheap page nodes rather than 178k tree items on every refresh. Filtering
  still searches the complete function set.

No G6 implementation items remain.

## Requested, not yet built

Raised 2026-08-07. Not started; recorded so the sequencing is a decision rather
than whatever gets remembered.

### The distinction these force: panes versus pages

Everything so far is a **pane** — narrow, glanceable, alive beside the listing
while you read it. The requests below are for **pages**: wide, columnar,
searchable, and worth giving the editor area to.

The test is what the surface is *for*. A pane answers a question you have while
reading code, so it must be visible at the same time as the code. A page is
somewhere you go to look for something, and while you are there the listing is
not what you are doing. Getting this backwards produces either a cramped table
or a sidebar you keep closing.

Both can exist for one dataset, and for some of them both should.

### R1 · Overview rows navigate — **done**

Each Overview row becomes an action rather than a readout:

- **Entry point** → navigate there through the focus bus.
- **Instructions** → open the listing.
- **Functions**, **References** → reveal those panes.

Cheap, and it turns the pane from a label into a table of contents. The focus
bus already carries every one of these.

The actionable row model is covered independently of workbench contribution
registration, including preservation of wire addresses above `2^53`.

### R2 · Strings as a page — **done**

Strings is the clearest case for a page: thousands of entries, and string
hunting is a distinct activity rather than a question asked mid-read. It wants
columns (address, encoding, text), a filter, and the room to show a long string
without truncation.

The sidebar pane goes away when this lands — a 2,000-row cap in a 300px column
was always a stand-in.

Needs the display cap lifted, since the point of the page is finding things.

### R3 · Imports as a page — M, and **do R2 first**

Same shape as R2, but the argument is weaker and the answer may be "not yet".
Imports are consulted *while reading the listing* — "what does this call
reach?" — which is pane behaviour, not page behaviour. A page competes with the
listing for the same space and loses the side-by-side that makes it useful.

What the current pane actually lacks is **width and a filter**, not a different
home: `CreateRemoteThread` alongside its module and IAT address does not fit in
a sidebar column.

So: add a filter to the existing pane first. It is much cheaper and may be the
whole fix. Promote to a page only if it still feels cramped afterwards — and if
it does, keep the pane as well, because the two serve different activities.

## Deliberately not here

- **Named symbols.** Everything is labelled by address until Stage F lands the
  interpretation layer. These panes are what make that absence *felt*, which is
  the right order: build the surfaces, then give them something to say.
- **A hex view.** Still slid to P4.
- **Filtering by xref kind**, grouping references by function — both want names.
