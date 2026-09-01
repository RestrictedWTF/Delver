# 0021 — The provider issues the Moment, and every read carries it

**Status:** proposed
**Date:** 2026-09-01
**Affects:** `CLAUDE.md` invariant 1 ·
[0018](0018-one-moment-taxonomy.md) ·
[`architecture/data-model.md`](../../architecture/data-model.md) §2 ·
[`planning/defect-audit.md`](../../planning/defect-audit.md) #47 ·
`delver-protocol/src/message.rs` · `platform/delver/common/delverAnalysisService.ts` ·
`platform/delver/node/analysisSession.ts`

## Context

Invariant 1: "Every read of target data takes an `ILocation` **and** an
`IMoment`. No exceptions, including the file provider where the Moment is
constant."

[0018](0018-one-moment-taxonomy.md) made `ReadMemoryParams.moment` **required**
on the wire, having found it optional and dropped: "invariant 1 satisfied in the
type and in no byte on the wire." The same defect then reappeared one layer up
and was found on 2026-09-01 (#47):

- `IDelverAnalysisService.readMemory(sessionId, space, address, count)` takes no
  Moment at all.
- `AnalysisSession.readMemory(..., moment: IMoment = STATIC_MOMENT)` supplies one
  as a **default parameter**.

So no TypeScript caller can pass a Moment, and every renderer read is `Static` by
omission rather than by anyone's claim. The invariant holds below the process
boundary and not above it.

The obvious repair — make the parameter required — does not work, and that is the
whole reason this needs a decision rather than a patch. **`IOpenImageResult`
carries no Moment field.** The provider never tells the renderer what Moment its
data is at, so a required parameter would only move the fabrication one line up:
some caller would still invent `STATIC_MOMENT` out of nothing. The renderer has
no authoritative Moment to pass.

## Decision

**`openImage` returns the Moment the provider is serving. The session carries it.
Every read passes it.**

- `OpenImageResult` gains a `MomentWire`. The provider is the authority — it is
  the thing that knows whether the bytes are a file on disk, a halted process, or
  a capture, and it already stamps the epoch.
- The renderer session holds that Moment and hands it to each read. For a file
  target it is `Static` with a constant epoch, which is exactly what
  [0018](0018-one-moment-taxonomy.md) says `Static` means, and the value is now
  *reported* rather than assumed.
- `IDelverAnalysisService.readMemory` takes an `IMoment`, required. The default
  parameter on `AnalysisSession.readMemory` goes.

The gain is not tidiness. When P4 lands, a debugger provider returns `Frozen`
with an advancing epoch and every existing read follows it with no signature
change — which is the property [0018](0018-one-moment-taxonomy.md) claimed the
taxonomy already bought and which is currently untrue above the boundary.

## Consequences

Two callers change (`delverAgentService.ts:1807` and `:1955`), plus the service
interface, its node implementation, and the protocol crate with a regenerated
`protocol.generated.ts` (invariant 12). Small, and it should be done while it is
small.

A test can now assert the invariant, which nothing does today: `common/wire.ts`
has no importing test at all, so the `"0x…"` encoding and the Moment plumbing are
both unguarded. A read that reaches the provider with the session's Moment is
observable at the wire.

The cost is that a provider must now answer "what Moment is this?" at open time.
For `provider-file` that is a constant. For a future debugger provider it is a
real question — and one it has to answer anyway.

## Alternatives

| Option | Why not |
| --- | --- |
| **B — scope the Moment to the session and amend invariant 1** | Cheap and honest about today: state that the Moment is established at session scope rather than per call. It weakens the rule [0018](0018-one-moment-taxonomy.md) was written to strengthen, and invariant 1's own words are "no exceptions, including the file provider where the Moment is constant" — B is precisely that exception. P4 would have to revisit it under deadline |
| Make the parameter required and let callers pass `STATIC_MOMENT` | The repair that looks right and is not. It satisfies the signature while the value is still invented at the call site, which is the defect 0018 already fixed once. A fabricated Moment is worse than an absent one, because it looks like an answer |
| Leave it; the file provider's Moment really is constant | True today and true of exactly one provider. The invariant exists because the second provider is where the assumption breaks, and by then every read site is written as though it does not matter |
