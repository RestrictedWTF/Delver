# P2b Project and Decompiler Integration Plan

## Problem

The SQLite project store, decompiler result cache, and backend host exist, but
they are not yet one lifecycle:

- `.delverdb` can be written and read by the platform store, but the workbench
  has no **Open Delver Project** flow and currently treats a selected database
  as a binary target.
- Saved `decompiled_functions` rows are never loaded into the workbench
  decompiler cache, so opening a pseudocode pane always reaches a backend.
- The UI reports the configured backend family rather than the backend that
  actually answered.
- A PyGhidra startup or handshake failure silently falls back to one-shot
  headless Ghidra, hiding the failure and paying full import/analysis cost on
  each request.

The project database must be the durable first source for saved analysis. A
backend is needed only for content not already present or for an explicit
refresh.

## Invariants

1. Opening saved pseudocode never starts Ghidra.
2. A `.delverdb` opens as a project, never as a binary image.
3. A project opens without the original sample; panes backed by saved snapshots
   remain useful offline.
4. Attaching a sample verifies its SHA-256 against the selected revision before
   live analysis is exposed.
5. F5 never silently changes backend. Backend startup failure is visible and
   copyable, with an explicit recovery action.
6. Cache identity includes revision content hash, backend id/version, result
   schema, and analysis profile.
7. A request for function B can never display or persist function A's result.
8. Portable SQLite state and disposable Ghidra/IDA native databases remain
   separate.

## Slice 1 — Honest Backend State and Timing

- Replace the synchronous configured-path status with an observable state:
  `unconfigured`, `starting`, `ready`, `failed`, or `disabled`.
- Report the actual backend id, version, adapter version, process generation,
  and last startup diagnostic in the pseudocode pane and output channel.
- Record timings for process spawn, handshake, target import/open, function
  recovery, decompilation, serialization, and project write.
- Start PyGhidra once in the background when a target or project is opened.
- Remove automatic headless fallback after a PyGhidra timeout or startup error.
  Offer **Retry PyGhidra** and **Use Slow Headless Once** explicitly.
- Keep headless as a compatibility backend selected by user action or setting,
  never as an invisible normal path.

Acceptance:

- the backend shown in the UI matches the backend id persisted in SQLite;
- a failed worker shows its copyable stderr instead of beginning a minute-long
  headless request;
- one timing record identifies which phase consumed the time.

## Slice 2 — Real Project Open and Offline Session

- Add **Delver: Open Project...** and associate `.delverdb` with the project
  input, separate from **Open Target**.
- Introduce a project session whose selected revision may have an optional live
  target attachment. Do not require an analysis-process session for offline
  data.
- Load metadata, selected revision, image info, functions, imports, exports,
  strings, interpretations, and decompiled functions through `loadSnapshot()`.
- Route panes through a snapshot/live-source abstraction: saved categories are
  available immediately; missing categories request an attached live target.
- Add **Locate Target...** for operations requiring bytes and reject a sample
  whose hash does not match the selected revision.
- When a raw binary has a matching adjacent project, offer to open that project
  and attach the already-open target.

Acceptance:

- opening `Auto-updater.exe.delverdb` does not spawn provider-file, the analysis
  server, Python, Java, or Ghidra;
- saved Functions, Strings, Imports, Exports, and Pseudocode open with the sample
  moved or unavailable;
- attaching the wrong executable is rejected without changing the session.

## Slice 3 — Read-Through Pseudocode Persistence

- Add a project-backed decompilation repository in front of backend execution.
- Hydrate and validate all saved `decompiled_functions` for the selected
  revision. Index them by backend id/version, result schema, normalized function
  RVA, and analysis profile.
- On F5 or pane restoration, return an exact saved result first. Show a small
  `Saved · <backend> <version>` provenance indicator.
- Add an explicit **Re-decompile Function** action that bypasses the saved result
  and atomically replaces/upserts it only after successful validation.
- Coalesce concurrent requests for the same key and retain the bounded in-memory
  LRU for unsaved sessions.
- Ignore and diagnose legacy rows whose function RVA is not present in the
  revision's current function snapshot; never surface them as another function.

Acceptance:

- reopening a saved `0x1080` pane performs zero backend calls and completes from
  SQLite within 200 ms on the test fixture;
- two saved RVAs with different payloads always produce different editor models;
- malformed, mismatched, or stale rows are skipped with a copyable diagnostic;
- re-decompile cancellation leaves the prior saved result intact.

## Slice 4 — Persistent Native Analysis and Cold-Path Policy

- Complete content-addressed Ghidra project reuse in user data, keyed by target
  hash, Ghidra version, adapter version, schema, and named analysis profile.
- Distinguish `fast-on-demand` from `full-analysis`. F5 uses the fast profile;
  full analysis is an explicit/background project operation with progress and
  cancellation.
- Keep one JVM and one retained Program/DecompInterface per active target.
- Prewarm the configured worker without blocking project-backed panes.
- Add cache inspection/invalidation commands and bounded cleanup policy.
- Apply the same backend-neutral lifecycle to a future IDAPython/Hex-Rays host.

Acceptance:

- after worker readiness, a second uncached function does not reimport the
  target or launch another JVM;
- reopening a native cache avoids full target analysis;
- deleting the native cache affects speed only, never portable saved work;
- performance tests report phase timings rather than relying on one total.

## Delivery Order

Implement Slice 1 first because it stops the hidden one-minute fallback and
makes every later performance report trustworthy. Slice 2 establishes correct
`.delverdb` semantics. Slice 3 then makes saved pseudocode instant. Slice 4
optimizes genuinely uncached work after the durable path is correct.

Each slice lands with focused common, Node, renderer, and real-backend smoke
tests before the next slice begins.
