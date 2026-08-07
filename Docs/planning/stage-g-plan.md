# Stage G — The workspace panes

**Status:** planned
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

Still wanted: a filter box, and an encoding column rather than a suffix.

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

Still wanted:

- Filter boxes on Functions, Imports, and Strings.
- Full virtualization for Functions, replacing the 1,000-row cap.

## Deliberately not here

- **Named symbols.** Everything is labelled by address until Stage F lands the
  interpretation layer. These panes are what make that absence *felt*, which is
  the right order: build the surfaces, then give them something to say.
- **A hex view.** Still slid to P4.
- **Filtering by xref kind**, grouping references by function — both want names.
