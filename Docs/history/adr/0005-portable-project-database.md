# 0005 — Portable project database and session save lifecycle

**Status:** accepted
**Date:** 2026-08-11
**Supersedes:** [0004 — Where authored interpretation is stored](0004-interpretation-store-location.md)
**Affects:** [`architecture/data-model.md`](../../architecture/data-model.md) §7 ·
[`architecture/session-persistence.md`](../../architecture/session-persistence.md) ·
`delver/delver-store` · `services/delver/common/projectService.ts`

## Context

ADR 0004 optimized for automatic recovery of authored interpretation: an
append-only JSONL file in user data, found by content hash. Decompilation made
the missing half visible. An analyst expects an IDA-like project to retain the
whole useful state — functions, strings, facts, pseudocode, names, comments, and
findings — and to be a file they can deliberately name, move, archive, or share.

The target cannot be the project container. Samples are often read-only,
renamed, quarantined, or intentionally withheld from collaborators. Backend
native state is not a portable substitute either: a Ghidra project is
version-coupled local acceleration, while a future IDA database has different
licensing, format, and lifecycle constraints.

## Decision

Delver projects are single, user-chosen `.delverdb` SQLite files. A project
contains derived facts and decompiled output as well as the append-only authored
interpretation log, but never contains the target's sample bytes. It records the
target content hash and optional source locator, and remains useful when the
sample is absent.

Opening a raw binary creates an untitled session. Once that session gains new
analysis content, closing it, replacing its target, or shutting down prompts
**Save**, **Don't Save**, or **Cancel**. Save chooses a `.delverdb` destination;
Don't Save discards the untitled project state; Cancel aborts the triggering
operation. Named projects autosave changes incrementally and do not repeatedly
prompt.

Backend-native projects are separate local caches. In particular, Ghidra state
lives under user data, keyed by target content hash and qualified by backend,
backend version, and analysis profile. It is disposable, nonportable, and never
the record of user work. The `.delverdb` stores portable results and provenance;
cache entries and derived rows are reused only when their content hash, backend,
backend version, analysis profile, and schema version are compatible.

## Alternatives

| Option | Why not |
| --- | --- |
| Keep ADR 0004's automatic per-hash JSONL store | Preserves annotations, but not functions, strings, pseudocode, findings, or session state; it also hides the analyst's project rather than making save/discard an explicit choice. |
| Make the Ghidra or IDA database the project | Couples Delver's durable format to one optional backend and its installed version/license, and cannot support backend-independent opening or sharing. |
| Embed the sample bytes in `.delverdb` | Makes offline re-analysis convenient, but makes ordinary project sharing capable of silently distributing malware. A user may share the sample separately and explicitly. |
| Always save untitled analysis in user data | Avoids a prompt, but violates the user's choice to discard exploratory analysis and recreates the hidden-location problem from ADR 0004. |

## Consequences

**Makes easy**

- Reopen or share one analysis file without sharing the sample.
- Review cached facts, pseudocode, and authored work on a machine without the
  original target or decompiler installation.
- Reuse expensive Ghidra analysis locally without confusing its cache with the
  portable project.
- Preserve work continuously after the analyst has chosen a project location.

**Makes hard**

- SQLite needs explicit schema migration, transactional writes, and WAL
  checkpointing so a saved or copied project is one complete file at rest.
- Operations that replace an untitled dirty session become cancellable UI flows.
- Reattaching a sample requires hashing it before trusting any stored addresses;
  a mismatch must not silently bind the project to different bytes.
- Backend-derived data needs provenance and selective invalidation rather than a
  single global cache clear.

**Would cause a revisit**

A requirement for simultaneous multi-user editing would add synchronization or
a server in front of this format. It would not make a backend-native project the
record of truth or justify embedding sample bytes by default.
