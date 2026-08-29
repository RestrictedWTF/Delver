# 0003 — Bounded unsafe code in `delver-rpc` local transport listener

**Status:** superseded by [0010](0010-unsafe-code-in-os-security-modules.md)  
**Date:** 2026-08-06  
**Affects:** `delver-rpc` crate-level `#![forbid(unsafe_code)]` · `CLAUDE.md`
invariant 13

## Context

P1 decision E1 requires `provider-file` to accept multiple concurrent clients
over a local transport. The workbench and the analysis server both connect to
the same provider. On Windows the chosen transport is a named pipe with a
per-session random name and a DACL restricted to the current user; on Unix it
is a Unix domain socket in a mode-0700 directory.

`delver-rpc` deliberately ships with `#![forbid(unsafe_code)]` because it
handles bytes from external providers and CLAUDE.md invariant 13 requires that
byte-parsing code be Rust and `#![forbid(unsafe_code)]` where possible.

The local listener is different from the framing layer:

- It does not parse, interpret, or trust the bytes that flow through it.
- It only creates OS kernel objects (named pipes, sockets) and accepts
  connections.
- On Windows, setting a user-restricted DACL requires calling Win32 security
  APIs that have no safe wrapper in the project's existing dependency tree.

Two alternatives were considered:

1. **Add a safe wrapper crate** such as `interprocess`. It handles named pipes
   and Unix sockets without local unsafe code, but it does not expose ACL
   control on Windows, so it cannot satisfy the user-restricted pipe
   requirement.
2. **Use `windows-sys` directly** inside a Windows-only module and isolate the
   unsafe code. This keeps the dependency tree small (`windows-sys` is already a
   transitive dependency) and satisfies the ACL requirement.

We chose option 2.

## Decision

`delver-rpc` crate-level lint is relaxed from `#![forbid(unsafe_code)]` to
`#![deny(unsafe_code)]`. The Windows listener module
(`src/listener_windows.rs`) carries `#![allow(unsafe_code)]` and is the only
module permitted to use `unsafe`.

The unsafe block is confined to:

- Creating a `SECURITY_DESCRIPTOR` and ACL for the current user SID.
- Calling `CreateNamedPipeW`, `ConnectNamedPipe`, and `DuplicateHandle`.
- Converting returned handles into `std::fs::File` halves for the framed
  transport.

No unsafe code is used for framing, parsing, serialization, or any code path
that touches attacker-controlled bytes.

## Consequences

- `delver-rpc` still forbids unsafe code everywhere except the one OS-specific
  listener module.
- Future transport work that can avoid unsafe (e.g. Unix sockets, higher-level
  wrappers) remains forbidden from using it.
- If a safe, ACL-capable named-pipe crate appears, the unsafe module should be
  replaced and the crate-level lint reverted to `#![forbid(unsafe_code)]`.

## Related

- [P1 plan](../../planning/p1-plan.md) decision E1
- `delver-rpc/src/listener_windows.rs`
