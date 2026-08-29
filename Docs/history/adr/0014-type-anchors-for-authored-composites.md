# 0014 — An anchor may name a type instead of a place

**Status:** accepted
**Date:** 2026-08-28
**Affects:** `CLAUDE.md` invariant 4 · [0006](0006-proposal-resolution-in-the-edit-log.md) ·
[0013](0013-accepted-semantics-as-decompilation-input.md) ·
[`architecture/data-model.md`](../../architecture/data-model.md) §4 ·
`platform/delver/common/interpretation.ts` ·
`platform/delver/common/delverInterpretationStoreService.ts` ·
`platform/delver/common/findings.ts` ·
`services/delver/common/delverDecompilerService.ts` ·
`contrib/delverAI/browser/delverReviewView.ts`

## Context

Every anchor the data model defines is a location. `image` is an RVA in an
image, `symbol` an offset from a name, `alloc` an offset into a live allocation,
`absolute` an address in one moment
([`data-model.md`](../../architecture/data-model.md) §4). Invariant 4 pins the
preferred one to `(contentHash, rva)`. Every authored edit so far has fit: a
rename, a comment, a tag, a data type, a function prototype are all *about
something at an address*.

A composite is the first authored thing with no location. `struct Config` is not
*at* an RVA — several addresses may hold one, and none of them owns the layout.
There was nowhere in an address-anchored log to put it, and
[0013](0013-accepted-semantics-as-decompilation-input.md) had just made the
accepted type model an input to decompilation, so that gap was now the thing
standing between an agent and a layout it could introduce.

What we did not know when invariant 4 was written: whether "anchor" meant
"place" because places were all we had, or because a place was the point. The
answer is the first. The invariant exists to stop annotations binding to
*absolute* addresses, which ASLR, a re-dump, and a re-base all move.

## Decision

**An anchor may name a type instead of a place.** `Anchor` becomes
`IImageAnchor | ITypeAnchor`, where a type anchor is
`{ kind: 'type'; contentHash; name }`, and `EditOp.CompositeType` records one
named composite's layout.

- A type anchor is still scoped to `contentHash` and still carries nothing
  relocation can invalidate. **Invariant 4 is intact**: what widens is only the
  claim that an anchor names a place, not the rule against binding to an address
  that moves. `anchorKey` puts the kind in the key — `<hash>:type:<name>` beside
  `<hash>:rva:<hex>` — so a type can never share a slot with an address that
  happens to render the same way.
- The wire form is a discriminated union, not one shape with optional fields. A
  reader that has not been taught about `type` must fail to parse it rather than
  silently read a named composite as an edit at RVA 0.
- `EditOp.CompositeType` carries **canonical JSON** — `kind`, `size`, and fields
  at explicit offsets — as the edit value, materialized into
  `IInterpretationAt.compositeType`. It is not a C declaration string.
- Everything else is unchanged, deliberately. A composite edit is proposed,
  accepted, compensated, reverted, exported and imported by exactly the machinery
  that already existed, because that machinery keys on `(anchor, op)` and never
  on an address.
- `IDelverFindingEvidence.anchor` and `IDelverFinding.anchors` narrow to
  `IImageAnchor`. Findings are permanently location-only.

## Alternatives

| Option | Why not |
| --- | --- |
| Anchor the definition to an RVA that uses the struct | No model change at all, and the shortest path. It is also wrong about where the type is: two addresses holding one `struct Config` either duplicate the layout or contradict each other, and clearing becomes ambiguous — clearing at one use site leaves the other still asserting a layout the analyst believed they had removed. The review row would read "at 0x…" and send the reviewer to look at a place that does not own what they are accepting |
| A separate authored type store keyed by `(contentHash, name)` | Honest about the shape: a composite really is name-keyed, not address-keyed. It buys nothing, because everything the edit log already does is something composites need — proposal and acceptance ([0006](0006-proposal-resolution-in-the-edit-log.md)), undo by compensation, per-author revert, `.delverlog` export and import, conflict handling on save. Either all of it is duplicated for one new kind of subject, or it is generalized to serve both stores — which is this decision reached by a longer route and with two places to keep in step |
| Keep composites out of the model; let an agent reference only types the program already carries | The status quo before this change. It means an agent can *use* `struct _IMAGE_DOS_HEADER` because Ghidra shipped it, and can never introduce a layout it worked out from the code — which is half of what S4 exists to deliver. It caps the analyst the same way: a struct recovered by hand has nowhere to live but a comment |
| Store the layout as a C declaration string, like `dataType` and `functionPrototype` | Reads far better in a log and needs no new value shape. Ghidra's `DataTypeParser` resolves type *references* and cannot define a layout, so the worker builds the structure field by field regardless (`apply_composites` in `delver_decompiler_worker.py`); a declaration string would have to be re-parsed back into fields to get there. Explicit offsets are the casualty — they would be surrendered to the parser's own packing rules, and padding in a real binary is something the analyst measured, not a flaw to tidy up |

## Consequences

**Makes easy**

- Composites cost no new lifecycle. Proposing, accepting, rejecting, undoing by
  compensation, reverting one author's work, and exporting a log all reached
  composites the day the op existed: `compensateLast` and `revertAuthor` group
  by `(anchorKey, op)` and read the replacement value through `valueAt`, and
  none of those knows what an anchor is.
- No `.delverdb` migration. `interpretations` stores each edit as an opaque
  `payload TEXT`; the only code that reads inside it is
  `interpretationIdentity`, which now takes `name` or `rva` by kind. The schema
  version did not move.
- A composite reaches the decompiler through
  [0013](0013-accepted-semantics-as-decompilation-input.md)'s existing envelope.
  `semanticDependenciesFor` collects type anchors alongside image anchors into
  one snapshot, so there is no second path to keep correct.

**Makes hard**

- `Anchor` no longer implies a location. Every consumer that read `anchor.rva`
  had to narrow first — twelve production sites and four in tests. Four of those
  are view surfaces (functions list, listing, pseudocode comments, xrefs) that
  now skip a non-location edit outright, which is correct: an address-ordered
  table has no row for a type. `isImageAnchor` and `isTypeAnchor` exist so every
  *new* consumer has to make the same choice deliberately, and the compiler is
  what asks.
- The `.delverlog` JSONL validator admits an anchor kind and an op by explicit
  list, so a build that has not been taught about `type` refuses the record
  rather than misreading it. Fail-closed is the right direction, but the refusal
  is total — an older build rejects the whole log, not the one line it does not
  understand. It also checks the *pairing*: a `compositeType` at an address and
  a rename on a type are both refused, because a looser validator would take
  either and nothing would ever read it — the snapshot builder looks only at
  type anchors, so the edit would be silently inert rather than rejected.
- A review row cannot show what is stored. Canonical JSON is the right durable
  form and the wrong tree label, so `compositeSummary` renders a shape —
  "struct, 40 bytes, 6 fields" — and the reviewer accepts a layout they read one
  click away in the log. Every other op's row shows the value itself.
- Findings are location-only forever, by decision rather than by accident. A
  finding is a claim about bytes, and there is nothing to cite in a range with no
  address.

**Would cause a revisit**

An authored subject that is neither a place nor a name within one image — a type
shared across images, or an authored call-graph edge — would need a third anchor
kind. At that point the union is worth reading as "what an edit is about" rather
than as a widened location, and invariant 4 should be reworded to match instead
of being read around.

## Note

`IDelverFindingEvidence` declared `anchor: Anchor` while its own wire type
`IDelverFindingAnchorWire` had always required `kind: 'image'`. The domain type
was the loose one, the two disagreed for as long as both existed, and nothing
caught it — a union with a single member cannot be narrowed wrongly. Adding a
second member is what surfaced it. Worth recording, because the same shape
recurs: a discriminated union with one case checks nothing, and every claim
resting on it is unverified until the second case arrives.

## Related

- [0006](0006-proposal-resolution-in-the-edit-log.md) — the review lifecycle composites inherit unchanged
- [0013](0013-accepted-semantics-as-decompilation-input.md) — the snapshot composites travel in, extended to `schemaVersion: 2` by this change
- `CLAUDE.md` invariant 4 — preserved: a type anchor is scoped to `contentHash` and holds nothing relocation moves
