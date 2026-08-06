# 0002 — Wire types separate from domain types

**Status:** accepted
**Date:** 2026-08-06
**Affects:** [`architecture/project-structure.md`](../../architecture/project-structure.md) §2–3 ·
`delver-core` and `delver-protocol`

## Context

Delver ships provider binaries that connect to a workbench built at a different
time — a provider running inside an analysis VM, or a third-party debugger
adapter someone wrote months ago
([target-providers.md](../../architecture/target-providers.md) §3). The wire
format therefore has to be stable and versioned independently of how Delver's
internals are organised.

The tempting shortcut is one set of types: annotate the domain types with serde
and send those. It's less code on day one.

## Decision

Two type sets, with conversions between them.

- **`delver-protocol`** — wire types. serde + schemars, hex-string `u64`s
  ([ADR 0001](0001-wire-protocol-framing-and-encoding.md)), versioned, changed
  only deliberately. This crate is the single source of truth for the protocol
  and generates both the JSON Schema and the TypeScript bindings.
- **`delver-core`** — domain types. Plain `u64`, ergonomic, refactored freely.
  **No serde derives.**
- `From` / `TryFrom` impls between them, living in `delver-protocol`.

Enforced by a test asserting `delver-core` contains no `Serialize` or
`Deserialize` derive. Cheap, and it catches the shortcut being taken
accidentally a year from now.

## Alternatives

| Option | Why not |
| --- | --- |
| **One type set with serde on the domain types** | Every internal refactor becomes a breaking protocol change, discovered when an older provider binary fails against a newer workbench. The failure mode is remote and confusing, which is the worst kind. |
| **Serde on core types with custom serializers per field** | Achieves the encoding but not the decoupling — the *shape* is still the domain shape, so renaming a field still breaks the wire. |
| **Generate domain types from the protocol schema** | Inverts the dependency: internal ergonomics become hostage to wire concerns, and `u64` ergonomics lose to hex strings. |

## Consequences

**Makes easy**

- Internal refactoring without protocol archaeology.
- A clear, small surface to review when the protocol version needs bumping —
  if `delver-protocol` didn't change, the wire didn't change.
- Schema and TypeScript generation have one obvious input.

**Makes hard**

- Conversion boilerplate. Mitigated by keeping wire types structurally close to
  domain types, so most impls are mechanical.
- Two places to add a field. This is the point, not an oversight: it forces the
  question "is this part of the contract, or just how we happen to store it?"

**Would cause a revisit**

If conversion boilerplate ever exceeds the value — but note that the pressure to
merge them will feel strongest early, when the wire has no external
implementations yet and the cost looks like pure overhead. That's exactly when
merging them is most damaging.
