# 0001 — Wire protocol: framing, number encoding, and errors

**Status:** accepted
**Date:** 2026-08-06
**Affects:** [`architecture/target-providers.md`](../../architecture/target-providers.md) §3 ·
root `CLAUDE.md` invariant 2 · every provider and client implementation

## Context

DTP carries three kinds of traffic between the workbench and out-of-process
providers: small request/response messages, bulk memory payloads that can reach
tens of megabytes, and server-initiated events.

Four constraints shaped the encoding:

- **Third parties must be able to implement a provider casually.** "Bring your
  own debugger" is a stated product goal
  ([target-providers.md](../../architecture/target-providers.md) §4). A protocol
  that takes an afternoon in any language beats a faster one that takes a week.
- **Addresses are `u64`.** Kernel addresses routinely exceed 2⁵³.
- **Provider binaries outlive IDE builds.** The wire format has to be stable and
  versioned independently of internal refactoring.
- **Bulk reads are on the interactive path.** Listing scroll at 60 fps means
  memory reads are latency-sensitive.

What we did not know at decision time: actual throughput requirements under a
real listing scroll, since no listing existed yet.

## Decision

**Framing.** LSP-style headers for JSON messages:

```
Content-Length: <n>\r\n
\r\n
<n bytes of UTF-8 JSON>
```

Binary payloads travel as separate frames:

```
Delver-Frame: <id>\r\n
Content-Length: <n>\r\n
\r\n
<n bytes raw>
```

A message references a frame inline — `{"data": {"$frame": 17, "len": 4096}}` —
and **the frame immediately follows the referencing message, before the next
JSON message.** That ordering rule keeps the reader a simple state machine
rather than a correlation table.

**Numbers.** Every `u64` on the wire — addresses, lengths, offsets — is a
`"0x..."` **string**. Never a JSON number.

**Errors.** JSON-RPC error objects. Standard codes for protocol failures, a
Delver range for domain failures carrying `data: { kind, detail }`. Initial
kinds: `ProtocolVersionMismatch`, `NotAttached`, `InvalidAddress`,
`UnreadableMemory`, `UnsupportedCapability`, `TargetBusy`.

A **partial** memory read is a success carrying valid-range information, not an
error. `UnreadableMemory` is raised only when nothing was readable.

## Alternatives

| Option | Why not |
| --- | --- |
| **JSON numbers for addresses** | IEEE 754 doubles. Silently truncates above 2⁵³ — `0x7FFFFFFFFFFFFFFF` becomes a different address with no error raised anywhere. Serde emits `u64` this way by default, so this is the failure you get from doing nothing. Disqualifying. |
| **Split hi/lo `u32` pairs** | Lossless, but unreadable in logs and easy to reassemble wrong. Hex strings cost the same bytes and are self-describing. |
| **MessagePack / CBOR** | Genuinely better: native `u64`, no base64 question, faster parse. Rejected on legibility and implementability — a JSON stream can be read in a log by a human, and a third-party provider author can implement it without a library. This is the closest call of the four. |
| **BigInt-aware JSON parser on the TS side** | Adds a renderer dependency, changes parse semantics process-wide, and does nothing for clients in other languages. |
| **gRPC / protobuf** | Codegen for both Rust and TS is attractive, but it raises the bar for casual third-party providers and is a heavier dependency in an Electron renderer. |
| **base64 bulk payloads inside JSON** | 33% inflation plus an encode/decode pass on a latency-sensitive path. A 16 MB region read is a measurable waste. |

## Consequences

**Makes easy**

- Any language can implement a provider with a JSON library and a byte reader.
- Protocol traffic is human-readable in a log, including addresses.
- Bulk payloads cost nothing beyond a memcpy.

**Makes hard**

- Every client needs a hex helper on both sides. Serde needs
  `#[serde(with = "hex_u64")]` on every `u64` field — easy to forget, so this is
  covered by a round-trip test asserting `0x7FFFFFFFFFFFFFFF` survives
  serialize → JSON → deserialize.
- Hex strings are roughly 2.5× the bytes of a raw JSON number. Irrelevant in
  practice: addresses are a tiny fraction of payload, and bulk data is in
  frames.
- The frame-ordering rule means a provider can't interleave a large response
  with other traffic. Acceptable at current scale; revisit if a provider needs
  to multiplex.

**Would cause a revisit**

Profiling showing JSON parse or serialize dominating listing-scroll latency. The
escape hatch is MessagePack with the same message shapes and the same framing —
the `$frame` indirection and the type definitions survive that swap unchanged.
