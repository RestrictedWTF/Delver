# 0018 — One Moment taxonomy, and the epoch carries the position

**Status:** accepted
**Date:** 2026-08-31
**Affects:** `CLAUDE.md` invariant 1 ·
[`architecture/data-model.md`](../../architecture/data-model.md) §2 ·
[`architecture/debugger-provider.md`](../../architecture/debugger-provider.md) ·
[`planning/roadmap.md`](../../planning/roadmap.md) P4, P7 ·
`delver-core/src/lib.rs` · `delver-protocol/src/message.rs` ·
`platform/delver/common/moment.ts`

## Context

`MomentKind` was defined twice, differently, and nobody noticed because only one
value has ever been produced.

| | |
| --- | --- |
| `data-model.md` §2 | `Live \| Frozen \| Snapshot \| Replay` |
| `delver-core/src/lib.rs` | `Static \| Snapshot \| Live` |

`Static` — the only kind anything sends — is absent from the design doc.
`Frozen` and `Replay` are absent from the code, and both are committed to
elsewhere:

- `roadmap.md` P4: "Real `Moment` handling: **Live vs. Frozen**, staleness
  indicators."
- `debugger-provider.md`: "Stopped at an event → `MomentKind::Frozen`. Reads
  within that epoch are coherent and can be cached aggressively. Running →
  `MomentKind::Live`. Reads are best-effort…"
- `roadmap.md` P7 exit: "`MomentKind.Replay` activates for time travel **with no
  data-model change** — it was designed in at P0."

That last sentence is false as written: activating `Replay` today means adding a
variant, which changes every `match` and every cache key derived from a moment.
The claim was made because the design intended the variant to exist from the
start; the code never carried it.

The two definitions also disagree about shape. The doc's `IMoment` has
`snapshotId?: string` and `tick?: bigint`; `MomentWire` has `kind` and `epoch`
only.

## Decision

**One taxonomy, five kinds, and the epoch carries the position.**

`MomentKind` is `Static | Frozen | Snapshot | Live | Replay` in both places.
Each names a guarantee a reader must be able to branch on, and they are
different guarantees rather than shades of one:

| Kind | The guarantee | Cacheable |
| --- | --- | --- |
| `Static` | Content cannot change. A file on disk. | Forever |
| `Frozen` | A live target, halted. Reads within the epoch are coherent. | Within the epoch |
| `Snapshot` | A captured, immutable state of a live target. | Forever, per capture |
| `Live` | Running. Reads may observe change between calls, and may tear. | Milliseconds, labelled |
| `Replay` | A position in a recorded execution trace. | Per position |

`Static` and `Snapshot` are both immutable and are still distinct: a file has no
originating target and no capture to be stale against, while a snapshot can be
stale relative to the process it came from, which is exactly what the "target
advanced" strip in §2's rules exists to say.

**The shape stays `kind` + `epoch`.** `snapshotId` and `tick` are not added.

- `tick` is `epoch`. `MomentWire::epoch` is already documented as a `u64` a
  provider "is free to stamp with a tick count", which is what a trace position
  is. Two monotonic per-target counters would be one too many, and the second
  would be null for every provider but one.
- `snapshotId` duplicates target identity. A capture is a target, and a target
  is already identified by its content hash; a moment naming the capture as well
  invites the two to disagree.
- Adding optional fields nothing produces is the specific mistake this reconciles
  against. `ReadMemoryParams.moment` was an optional field every caller set to
  `None` and the provider dropped — invariant 1 satisfied in the type and in no
  byte on the wire. Two more such fields would repeat it, and their absence is
  cheaper to fix later than their emptiness is to notice.

With this, the P7 exit criterion becomes true rather than aspirational: `Replay`
activates by producing a kind that already exists, against a field that already
carries the position.

## Consequences

Three of the five kinds are produced by nothing today, and are reserved on the
same terms as `ResolutionConfidence::Probable` — documented at the definition,
with what they wait for. That is the point of reserving them: a `match` written
now is exhaustive over the axis P4 and P7 will actually use, and the compiler
asks the next consumer rather than a later migration doing it.

The file provider refuses every kind but `Static`, through a catch-all rather
than an enumerated list, so adding these variants required no change to its
refusal path and adding a sixth would not either.

This does not make the debugger work cheaper. It makes the *shape* of that work
fixed, so P4 spends its time on epochs and staleness rather than on widening a
type every read already switches on.

## Alternatives

| Option | Why not |
| --- | --- |
| Shrink the doc to `Static \| Snapshot \| Live` | The smallest change, and it deletes distinctions three documents rely on. `debugger-provider.md`'s caching rule is precisely "Frozen may be cached aggressively, Live may not"; collapsing them means a halted target's coherent reads are labelled best-effort, or a running target's torn reads are cached |
| Add the variants when P4 needs them | Defensible, and it is what the roadmap assumed had already been avoided. The cost is not the variant, it is that every `match` over a moment and every cache key derived from one changes at the moment the debugger lands — the phase least able to absorb an unrelated migration |
| Add `snapshotId` and `tick` to match the doc exactly | Faithful to the written shape. It also adds two fields no provider populates, to fix a defect whose cause was a field no caller populated |
| Leave both definitions and note the divergence | Costs nothing today and nothing until the first non-file provider, at which point someone picks a taxonomy under deadline. The two definitions have already drifted once without being noticed |
