# 0009 — One address-ordered listing over the whole image

**Status:** accepted
**Date:** 2026-08-26
**Affects:** `delver-analysis/src/listing.rs` · `delver-protocol/src/message.rs` ·
`server-analysis/src/main.rs` ·
`contrib/delverListing/browser/delverListingModel.ts` ·
[ADR 0001](0001-wire-protocol-framing-and-encoding.md) ·
[`design/principles.md`](../../design/principles.md) §1

## Context

The listing was three concatenated blocks: a client-authored metadata header,
every decoded instruction, then the entire string table appended after the last
one. Row ordinal mapped onto the instruction index by subtracting the header,
and strings were client-side rows the server never saw.

That shape is wrong in a way an analyst hits immediately. Clicking a string in
the strings view navigated to the appended block, so the listing showed a wall
of strings — mostly `.rdata`, plus every scanner hit inside `.text` — instead of
the address the analyst clicked. Scrolling past the last instruction fell off
the end of the code into that same block rather than into `.rdata` where
`.rdata` begins. Reported on 2026-08-26: *"it loads only .rdata and some weird
strings in .text instead of loading the entire .text and then .rdata basically
combined."*

The underlying claim was that a listing is a view of the code. It is not. A
listing is a view of the **image**, and the analyst reads across the boundary
between code and data constantly — a string is interesting precisely because of
the instruction that references it.

## Decision

**The listing is one address-ordered row space over the whole image, owned by
the analysis server.**

`ListingIndex` merges the instruction index with the string table by address.
Instructions keep `InstructionIndex`'s two-parallel-array representation, and
strings fold in as three vectors sized by the string count — thousands of
entries, not the millions a merged row array would need
([`data-model.md`](../../architecture/data-model.md) §1). Row lookup in either
direction stays O(log n).

`analysis/listingWindow` returns `ListingWindowRowWire`, a **serde-tagged
union** — `instruction` or `string`. Tagged rather than one struct with optional
fields: a client that has not been taught a row kind must fail to parse it, not
render a string as an instruction with an empty mnemonic
([`principles.md`](../../design/principles.md) §1). `ListingRowWire` keeps its
instruction shape and its existing consumers; signature generation and the agent
bridge both want instructions and nothing else, and they filter.

`analysis/rowForAddress` answers in the same space, so a string, a branch target
and a function entry all resolve through one call. The client's
`stringRowsByRva` side table is gone.

**A string that overlaps a decoded instruction keeps its own row.** A scanner
hit inside real code is usually a false positive, and IDA would not show it. But
dropping it here would make it unreachable from the strings view that still
lists it — an inconsistency the analyst can neither see nor explain. Both rows
exist, the string wins the address lookup because the caller who asked for it
came from somewhere that named it a string, and the analyst judges.

## Consequences

A window of N rows no longer yields N instructions. Every instruction-only
consumer filters, and the agent's `disassemble` cursor advances by the **window**
length rather than the filtered length — otherwise paging loops forever on a
window that happens to be all strings.

`ListingWindowResult.total_rows` counts instructions *and* strings, so the
client sizes its scrollbar from `instruction_count + strings.length`.

The TypeScript protocol generator learned tagged unions; it previously emitted
an empty interface for a `oneOf` over objects, which would have compiled and
silently typed every row as `{}`.

Function fingerprints are deliberately **not** affected. They hash instructions
in instruction-index space, and folding strings in would change every stored
signature.

## What this does not do

Undefined bytes — neither decoded instruction nor detected string — still have
no rows. The listing jumps over padding and unreferenced data rather than
showing `db` runs the way IDA does. The row model added here is what that would
need: it is another row kind and a third sequence to merge, additive to
everything above. Deferred because it multiplies the row count by the size of
the gaps and needs a policy for how far a run is grouped, and neither question
has an answer yet driven by real use.
