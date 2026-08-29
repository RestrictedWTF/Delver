# 0010 — Unsafe code in the OS security modules

**Status:** accepted
**Date:** 2026-08-27
**Affects:** supersedes [0003](0003-unsafe-code-in-transport-listener.md) · `delver-rpc`,
`provider-file` crate lints · `CLAUDE.md` invariant 13

## Context

ADR 0003 relaxed `delver-rpc` from `#![forbid(unsafe_code)]` to
`#![deny(unsafe_code)]` and recorded that `src/listener_windows.rs` "is the only
module permitted to use `unsafe`".

The 2026-08-26 defect audit (item #40) established that this is not what the
codebase does, and had not been for some time:

- `delver-rpc/src/listener_unix.rs` uses 4 `unsafe` blocks — `geteuid`, and
  `SO_PEERCRED`/`getpeereid` for peer authentication.
- `delver-rpc/src/private_directory_windows.rs` uses ~17 — SID construction, ACL
  assembly, and directory auditing.

Both already carried a module-scoped `#![allow(unsafe_code)]`, so the crate-level
`deny` was satisfied and no lint ever failed. Nothing was unsound; the ADR simply
stopped describing the code. That is the failure mode this project treats as
worse than no documentation at all, because it stops the next reader from
checking.

The audit found two further gaps:

- `provider-file` memory-maps an attacker-controlled sample and carried **neither**
  `forbid` nor `deny` — the one crate where the lint matters most had no lint.
- `listener_windows.rs`, the module ADR 0003 was actually written about, had **zero**
  SAFETY comments across ~25 blocks. The most-documented decision covered the
  least-documented code.

What we did not know when 0003 was written: that peer authentication on Unix and
private-directory ACLs on Windows would both need the same kind of raw OS call.
0003 generalized from a single module before there was evidence that only one
would ever be needed.

## Decision

Three modules may use `unsafe`, for one shared reason: they call OS identity and
access-control primitives that have no safe wrapper in the dependency tree.

| Module | Why |
| --- | --- |
| `delver-rpc/src/listener_windows.rs` | Named-pipe creation with a user-restricted DACL |
| `delver-rpc/src/listener_unix.rs` | Peer credential authentication |
| `delver-rpc/src/private_directory_windows.rs` | Private-directory SID/ACL construction and auditing |

Plus one narrowly scoped exemption outside `delver-rpc`: `provider-file` maps the
target read-only, which `memmap2` cannot express safely, because the file may be
modified by another process while mapped.

Three constraints apply to all four:

1. The `allow` is **module- or function-scoped**, never crate-level. Every crate
   root carries `forbid` or `deny`, `provider-file` included.
2. Every `unsafe` block carries a SAFETY comment stating the precondition it
   relies on.
3. **No `unsafe` on any path that interprets transport bytes or file contents.**
   Parsing stays in `delver-format`, which forbids it outright.

## Alternatives

| Option | Why not |
| --- | --- |
| Amend 0003 in place | ADR rule 2 — the value is in seeing what we believed then. 0003's belief that one module would suffice is exactly the thing worth preserving |
| Keep the exemption at one module and rewrite the other two safely | `SO_PEERCRED`/`getpeereid` and the Win32 ACL APIs have no safe wrapper in the tree; adding one (`nix`, `windows-acl`) buys a dependency to move the same `unsafe` behind someone else's version pin |
| `forbid` on `provider-file` and move the mmap elsewhere | The mmap *is* what `provider-file` is for. Relocating it moves the unsafe without reducing it, and puts it further from the bounds checks that constrain it |
| Leave `provider-file` unlinted | It maps attacker-controlled bytes. It is the crate most in need of the lint, not least |

## Consequences

- The three OS-security modules are a closed set. A fourth needs a new ADR, not a
  new `allow`.
- `listener_windows.rs` still needs SAFETY comments across its ~25 blocks — this
  ADR makes that a debt with a name rather than an unstated gap.
- One assumption is now written down that was previously only implicit: the
  `ACCESS_ALLOWED_ACE` pointer cast in `private_directory_windows.rs` is a *type*
  assumption, sound only because `AceType` is checked before any field past the
  common header is read.
- To revisit: if a safe, ACL-capable named-pipe crate and a safe peer-credential
  crate both appear, all three `delver-rpc` modules collapse and the crate returns
  to `forbid`. `provider-file` would still need its exemption.

## Related

- [0003](0003-unsafe-code-in-transport-listener.md) — superseded
- `Docs/planning/defect-audit.md` item #40
