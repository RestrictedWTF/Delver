# 0004 — Where authored interpretation is stored

**Status:** accepted
**Date:** 2026-08-08
**Affects:** [`architecture/data-model.md`](../../architecture/data-model.md) §3–4 ·
`delver/delver-store` · `services/delver/common/delverInterpretationService.ts`

## Context

Names, comments, and every other authored edit are the user's actual work, and
unlike the facts store they cannot be recomputed. Today they live in memory and
die with the window, which makes the whole interpretation layer a demonstration
rather than a tool.

Anchors are already `(contentHash, rva)` — interpretation is keyed to the
**bytes**, not to a path (ADR/data-model §4). Where the file holding it lives is
a separate question, and the two obvious answers pull in opposite directions.

Constraints that shaped the decision:

- **Targets are frequently unwritable.** Malware on a read-only share, anything
  in `System32`, a sample inside a mounted archive. Analysis must never fail
  because the folder next to the sample is not writable.
- **Samples move and get renamed constantly.** Triage copies a file three times
  before anyone names a function in it.
- **Sharing analysis matters**, but it is an occasional act, not the common path.

## Decision

**The store lives in user data, keyed by content hash**, with an explicit
export/import for sharing.

```
<userData>/delver/interpretation/<contentHash>.delverdb
```

**Format: append-only JSONL**, one edit per line. This falls directly out of the
log being append-only — writing an edit is appending a line, loading is
replaying the file through `InterpretationLog.from`. There is no rewrite path to
get wrong, and a crash costs at most the last edit.

**Sharing is a command**, not the storage layout: export writes the same JSONL
to a path the user picks; import replays it into the log for its content hash.

## Alternatives

| Option | Why not |
| --- | --- |
| **Beside the target** (`sample.exe.delverdb`, the IDA model) | Portable and obvious, and "send me your project file" needs no command. Rejected because it fails exactly where this tool is most used: a read-only sample share, `System32`, an archive mount. A tool that cannot save because of where the sample sits is worse than one whose files are less discoverable. It also orphans work the moment a sample is renamed or copied, which triage does constantly. |
| **Beside the target, falling back to user data** | Both behaviours, and now the user cannot answer "where is my work" without knowing which branch was taken. Two locations is worse than either one. |
| **A workspace `.delver/` folder** | Ties analysis to a folder, when the identity is the bytes. Opening the same sample from a different folder would lose the work. |
| **SQLite** | Wanted eventually for the facts cache, and premature here: it turns "append a line" into a schema and a migration story, for a file that is a linear log by design. Revisit if a single image's log grows past what a full replay can load comfortably. |

## Consequences

**Makes easy**

- Saving always works, whatever the sample's permissions.
- Re-opening the same bytes from any path finds the work automatically — the
  copy on the desktop and the copy on the share are the same analysis.
- Crash safety, and an audit trail that is literally the edit log.

**Makes hard**

- "Where is my work" needs a command to answer; the file is not discoverable by
  looking next to the sample. **Ship an export command with the store, not
  after** — without it the work is trapped.
- Two different files with identical bytes share one store. That is correct, but
  surprising the first time a renamed copy shows existing names.
- The store is not backed up alongside the sample, so a machine migration needs
  the user data folder.

**Would cause a revisit**

Replay time on load becoming noticeable, or a team wanting shared live analysis
rather than export/import. Both point at the same escape hatch: keep the JSONL
as the record of truth and put an index or a server in front of it.
