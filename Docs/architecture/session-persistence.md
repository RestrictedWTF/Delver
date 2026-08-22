# Session Persistence

Delver uses an IDA-like project lifecycle while keeping its durable state
independent of any decompiler backend. The portable project and a backend's
native analysis cache are different things and must never be conflated.

## Session kinds

Opening a raw binary creates an **untitled session**. The binary is the target,
not a project file, and no `.delverdb` is created until the user chooses Save.
The session may accumulate derived facts, functions, strings, decompiled code,
findings, interpretation edits, and useful presentation state in memory.

Opening a `.delverdb` creates a **saved project session**. Its target is optional:
stored facts, pseudocode, findings, and interpretation remain available when the
sample is missing. If the user locates the sample later, Delver computes its
content hash before attaching it and rejects a mismatch.

Only one raw target belongs to the initial project shape. Multi-image projects
must extend the schema explicitly rather than overloading a session identifier.

## Dirty state and save prompts

An untitled session becomes dirty when it receives durable analysis content:

- derived facts such as sections, imports, exports, functions, xrefs, and strings;
- decompiled output, variables, mappings, or backend diagnostics worth retaining;
- interpretation edits, findings, recipes, or other authored investigation data.

Transient navigation, selection, filtering, progress, and failed requests do not
make an untitled session dirty by themselves.

Closing a dirty untitled session, replacing its target, or shutting down Delver
must present **Save**, **Don't Save**, and **Cancel**:

- **Save** opens Save As when needed, commits a complete `.delverdb`, then
  continues the requested operation.
- **Don't Save** discards the untitled session's portable state, then continues.
  Disposable backend caches may remain because they contain no unique user work.
- **Cancel** leaves the session and target unchanged and aborts close,
  replacement, or shutdown.

An untitled session with no new analysis content closes without prompting.

After the user names a project, every durable change is autosaved incrementally
in a transaction. A named project therefore does not prompt on ordinary close;
an outstanding failed write is an error that must be resolved or explicitly
discarded, not silently treated as saved. Save As checkpoints the database and
continues autosaving to the new file.

## Portable `.delverdb`

`.delverdb` is SQLite with an explicit schema version. WAL may be used while the
project is open, but Save As, clean close, export, and sharing checkpoint it so
the artifact at rest is one self-contained file.

The database stores:

- target identity: content hash, format metadata, and an optional source locator;
- derived facts: functions, instructions, strings, xrefs, imports, exports, and
  other reproducible analysis;
- decompiler results: text, address mappings, recovered variables, diagnostics,
  and backend-specific optional artifacts;
- append-only interpretation, findings, recipes, and provenance;
- useful restorable project state such as open analysis editors and focus history.

It does **not** store target sample bytes, copied executable images, Ghidra
projects, IDA databases, credentials, or licenses. This lets an analyst share a
project without accidentally sharing malware. Views must degrade honestly when
the sample is absent: cached results remain readable, while operations requiring
bytes are disabled until the matching sample is attached.

## Identity, provenance, and invalidation

Every target-derived record belongs to a content hash. Backend-derived records
also carry the backend identifier, backend version, analysis profile, and the
Delver schema/version that produced them. A cached result is reusable only when
all relevant dimensions match:

```text
content hash × backend × backend version × analysis profile × schema version
```

Interpretation remains anchored to content hash and RVA and is not discarded
merely because a backend changes. Derived facts and pseudocode with incompatible
provenance remain either readable as historical results or are recomputed,
according to the row type; they must never masquerade as current output.

## Function identity across revisions

Two target content hashes are always distinct revisions; equal RVAs or function
sizes are not evidence that a function survived. Delver's first revision matcher
uses a versioned normalized listing fingerprint. It hashes instruction length,
flow kind, mnemonic, and operands while omitting row ordinals and instruction
RVAs. Direct branch and call targets become either a local instruction index or
an external-edge marker, so ordinary image relocation does not change the
fingerprint.

The current listing wire format cannot distinguish an address-bearing memory
operand from an immediate constant. Those operands therefore remain intact in
the exact fingerprint rather than being guessed away. This may miss a relocated
function, but cannot turn two different constants into an apparent exact match.

An exact fingerprint is accepted only when it occurs once in each revision.
Repeated thunks or identical folded functions are reported as ambiguous, not
paired by RVA or discovery order. Every accepted association records its method,
confidence, source and target content hashes, fingerprint algorithm, and
normalization version. Structural fuzzy matching is a separate follow-up; it
must expose its own evidence and lower confidence and must never silently move
authored interpretation.

For a unique exact match, Delver migrates function-entry names, comments, and
tags as new edits attributed to the source revision. It never overwrites a value
already authored for the destination revision. Instruction-address annotations
need basic-block/instruction correlation and remain on the source revision until
that lower-level mapping is implemented. Decompiled text is derived output and
is regenerated rather than copied between content hashes.

## Local backend cache

Ghidra's analyzed project is a local accelerator under Delver user data, keyed by
content hash and qualified by Ghidra/PyGhidra version plus analysis profile. It
can be evicted, rebuilt, or invalidated without losing anything authored. It is
not copied into `.delverdb` and is not expected to work on another machine.

The future IDA adapter follows the same boundary: any native IDA database used
to accelerate the worker is local backend state, while normalized results and
user work are saved in `.delverdb`. Backend discovery may offer to rebuild local
state from the matching sample, but opening the portable project never depends
on Ghidra, IDA, or the sample being installed or present.
