# Status

**Overwrite this file.** It answers one question: *where were we?* Keep it short
enough that reading it is faster than re-deriving it.

For what exists and what was skipped, see [ledger.md](ledger.md). For why
something is the way it is, see [adr/](../history/adr/).

---

**Last updated:** 2026-08-25
**Current phase:** P3c/P3d — reviewed evidence plus static-analysis depth (P3b client conformance and P3a/P2b real-project smoke continue alongside)

## Just landed

The workspace redesign is structurally complete. Delver's eleven analysis
surfaces no longer live as `ViewPane`s in one sidebar container; they are
segments of a three-zone workspace editor, one editor per target. Navigator
answers *what exists in this binary*, Primary *what am I reading*, Inspector
*what does the cursor touch*. Each zone is an independent column with its own
scroll, so no surface can shrink another — the property the container could not
provide, and the reason opening any pane used to resize every other one.

The sidebar container survives with a single view, a target launcher listing
open and recent targets. It exists only because an activity-bar entry *is* a
view container upstream; keeping the icon without one would mean patching
`activitybarPart.ts`. Its one view earns its place rather than being a stub.

Actions no longer bind to containers. `delverSelectionKind` and
`delverSelectionAddress` carry what is selected, and object-scoped actions
contribute to one `MenuDelverSelectionContext` — so "Generate Signature" cannot
appear while a section is selected, because it is not an action on sections.
Four dead `MenuId.ViewTitle` contributions are gone. A zone header now carries
only view state: pin, per `principles.md` §5.

**The lesson worth carrying forward:** every serious defect found in this work
had one shape — *a gate that assumed a single host*, failing silently. Actions
resolved the listing with `instanceof DelverListingEditor`. `LISTING_ACTIVE`
compared the active editor's id, which disabled every listing action inside the
workspace. A zone bound context off its selected segments without asking whether
it was visible, so hidden workspaces issued analysis requests and rewrote each
other's persisted state. None produced a type error.

**Not yet done:** the workbench has never been launched against this. Typecheck
is clean and 262 Delver browser tests pass, but no one has opened a target and
watched the zones behave. That is the next thing, and it is the only remaining
claim in this work that rests on reasoning rather than evidence.

### Earlier this phase

**Generate Signature...** now starts with an explicit policy choice:
relocation-stable remains the recommended first item, cross-revision-stable
uses retained earlier-revision proof, and unique-now keeps every current byte
exact. A successful cross-revision result shows its contributing revision count
and names alongside the IDA-style pattern before copy or save. The presentation
parser fails closed unless the policy is recognized, the revision count is
consistent, and every retained proof contains the exact generated primary
pattern. Earlier Revision Scan skips that prompt and requests
cross-revision-stable generation bound to the exact selected revision and saved
signature ids.

`delver_make_signature` now implements a conservative first
`cross-revision-stable` policy without trusting or reopening historical source
paths. It requires an exact, uniquely proven primary signature for the same
function identity in at least one earlier project revision, regenerates the
current candidate with relocation-aware masking, and accepts it only when the
identical masked pattern is still an exact unique match at the current function
entry. Results expose the contributing revision, signature, and source-call ids
as a separate proof chain; missing, conflicting, changed, or currently ambiguous
evidence fails closed with `ANALYSIS_INCOMPLETE`. Proven results can be named and
persisted with their `cross-revision-stable` policy in schema-v6 projects.
Optional paired `sourceRevisionId` and `sourceSignatureId` inputs bypass name
heuristics and bind the proof to one exact retained signature; selectors are
rejected for other policies or when only one is supplied.

The **Signatures** title bar now exposes **Export IDAPython Matchers...** for
live and offline project revisions. It writes one deterministic `.py` bundle
containing every saved primary signature, sorted by name. Each entry is checked
independently with the same exact-uniqueness, function-entry, and name-conflict
guards as the single matcher, and the script finishes with applied, already
named, preserved, missing, ambiguous, non-function, and rejected totals.
Xref-site alternatives are excluded because their pattern identifies a caller,
not the function entry that should receive the saved name.

Saved primary signatures now offer **Copy IDAPython Matcher** from their context
menu. The generated script uses IDA's current `find_bytes` API, scans the whole
IDB, proves there is exactly one match, requires that address to be an existing
function entry, and only replaces a dummy name. It preserves different authored
or otherwise non-trivial IDA names, jumps to a successful match, and reports
missing, ambiguous, non-function, or rejected-name outcomes without forcing a
mutation. Xref-site alternatives do not expose the action because their match
address is a call site rather than the identified function entry.

Accepting a regenerated unique primary result from **Earlier Revision Scan** now
persists a `signature` function-revision mapping with both retained search and
generation call ids. Delver revalidates the complete one-match search proof at
the project boundary, then transfers the older function's authored name,
comment, and tags. Missing target fields are accepted append-only imports;
different current values are preserved and emitted as proposals in **Review**.
Repeating the operation is idempotent for interpretation state and does not
duplicate an unresolved conflict proposal.

An exact primary match in **Earlier Revision Scan** can now be regenerated for
the current revision from its row context menu. Delver passes the matched RVA,
historical name, source revision id, and saved signature id into the canonical
cross-revision generator, then requires the identical masked pattern to prove
exactly one current-revision function-entry match before it can be saved. The
project boundary revalidates that exact binding before transferring annotations.
Ambiguous, missing, incomplete, and xref-site scan results never offer promotion
because they do not safely identify a current function entry.

The **Signatures** view can now scan saved patterns from earlier project
revisions against the attached current target. The cancellable scan is bounded
to 100 saved records, deduplicates identical pattern/scope searches, and asks
for only enough matches to distinguish an exact unique relocation from an
ambiguous one. Results remain visible as explicit `unique`, `ambiguous`,
`missing`, or `incomplete` evidence; unique and candidate matches navigate to
the listing. A one-match result proves relocation into this revision only and
is deliberately not presented as universal cross-revision stability.

Saved signatures can now be renamed or permanently deleted from their row
context menu. Renames preserve the signature's stable id and proof, reject
case-insensitive name conflicts, and update the SQLite record atomically;
deletion is revision-scoped, requires explicit confirmation, and refreshes the
view immediately for both untitled and named projects.

Saved signatures now expand into their retained evidence directly in the
**Signatures** view: the copyable IDA-style pattern, source function, generation
strategy, covered RVA range, exact uniqueness proof, quality score, and each
wildcarded operand with its relocation reason. Function, coverage, and wildcard
rows navigate back to the listing, so the durable claim can be inspected without
opening another surface.

The Delver sidebar now includes a **Signatures** view. Its leading search action
accepts IDA-style full-byte and nibble wildcard patterns, pages canonical
`delver_search_bytes` results, and opens each section-qualified match in the
listing. Durable named signatures appear in the same view and can be searched
against the attached image with one click; saves refresh the group immediately.
The view also exposes the listing's **Generate Signature...** action when a
function instruction is selected, keeping generation, reuse, and navigation in
one evidence-focused surface.

The listing editor now exposes **Generate Signature...** for the function under
the selected instruction. It selects exact-current, relocation-stable, or
retained-proof cross-revision policy over executable sections, shows the proven
primary and xref-site alternatives as uppercase IDA-style byte patterns, and
lets a human copy either pattern or save an exactly unique variant as named
project evidence. Generation is cancellable, ambiguous patterns remain copyable
but cannot be mislabeled as saved proof, and empty native signature-mask metadata
is serialized explicitly so stable instructions are distinguishable from an
outdated analysis backend.

Named signatures are now durable project evidence. `delver_save_signature`
accepts only a retained `delver_make_signature` call from the current target
revision and only a primary or xref-site variant with an exact one-match proof;
callers cannot inject an arbitrary pattern and label it proven. Names are
case-insensitive, replacement preserves a stable id, and schema v6 stores the
compact pattern, function/RVA, wildcard derivation, proof, quality, and source
call id per revision. `delver_list_signatures` pages and filters those records
from either a live target or an offline `.delverdb`. Schema v1-v5 projects
migrate forward with an empty signature table and retain all earlier evidence.

S2 now includes an instruction-aware SigMaker vertical slice.
`delver_make_signature` accepts an address or exact function name, grows a
candidate only at decoded instruction boundaries, and proves its match count in
the target function, all executable sections, or the raw-backed image. The
`relocation-stable` policy masks direct branch immediates, RIP/EIP-relative
memory displacements, and PE base-relocation fields from exact decoder/server
metadata and explains every wildcard. Results include covered instructions and
RVAs, match evidence, a deterministic quality score, and a separately proven
xref-site signature when the function bytes remain ambiguous. The conservative
`cross-revision-stable` policy additionally requires the identical
relocation-masked pattern to have retained exact uniqueness proofs for the same
function identity in earlier project revisions and to remain uniquely matched
in the current revision. It does not claim stability across revisions that lack
saved proof, and it never follows untrusted historical source paths.

S2 byte-pattern search is live. `delver_search_bytes` scans raw-backed image
section bytes for one-to-256-byte hexadecimal patterns with full-byte and
nibble wildcards. Optional exact section-name and executable-only filters are
bound into its revision cursor. Reads overlap by `patternLength - 1`, so matches
crossing a 64 KiB provider chunk and overlapping matches are not lost. A page
stops only after proving another match exists; continuing resumes at that match.
A complete zero-match result means every selected candidate position was read,
while a short provider read fails with `ANALYSIS_INCOMPLETE` instead of making a
false negative claim.

S2 now has canonical address conversion. `delver_convert_address` translates an
RVA, absolute VA, or raw file offset into the other spaces using the persisted
image base and PE section table, so it also works when a project is open without
its sample. Results identify the section and its exact half-open virtual/raw
ranges. A virtual zero-fill tail remains a valid RVA/VA with `fileBacked: false`;
headers, gaps, and values below the image base return `ADDRESS_NOT_MAPPED` rather
than inventing a correspondence.

The first S2 raw-evidence capability, `delver_read_bytes`, reads a bounded
range from image RVA or raw file-offset space through the provider's existing
binary-frame protocol. The shared-process boundary carries verified lowercase
hex rather than `Buffer` or `bigint`, while the dispatcher can additionally
decode exact `u8`, `u16le`, `u32le`, or `u64le` values as hexadecimal strings.
Provider-backed ranges, target moment, missing bytes, partial reads, and
image-range provenance remain explicit. The capability requires an attached
sample and is generated into both the built-in chat and MCP tool surfaces from
the canonical catalog.

Opening a named `.delverdb` now reuses its existing per-revision `sourcePath` to
attach the target automatically when the normalized absolute path is inside the
current workspace. The live provider's SHA-256 must match the selected project
revision before the attachment is published. Outside-workspace, missing, changed,
and path-traversal candidates leave the project offline and preserve the manual
**Locate Target...** recovery path; no sample bytes were added to schema v6.

P3c step 3 now has a direct tool-result evidence slice. Every successful
project-bound dispatcher exchange is retained per target revision with its
bounded exact request/result JSON, caller, capability, call id, and timings.
`delver_report_finding` accepts prior `sourceCallIds` on each range and rejects
dangling or cross-target references before retaining any finding. Review expands
those ranges into their cited capability/call rows; selecting a call opens a
read-only JSON evidence document with its identity, caller, timings, and complete
retained request/result. Portable-project schema v6
adds the `tool_calls` table and migrates v1-v4 projects in place; untitled
projects become dirty as soon as a project-bound exchange becomes authored
investigation state.

P3c steps 4 and 5 now have a first complete vertical slice. A **Review** tree in
the Delver activity-bar container combines pending interpretation proposals and
findings. Each row has human Accept/Reject actions; proposal rows navigate to
their anchor, and expanded finding evidence rows publish their exact half-open
image range through the focus bus. Interpretation decisions remain `resolves`
appends. Finding decisions are likewise separate append-only, human-authored
records, serialized per target revision in portable-project schema v6. The
project service validates a complete decision batch before retention, serializes
concurrent reviews per content hash, and fails closed on repeated decisions.

P3c step 2 now exposes four agent writes through the canonical dispatcher:
`delver_propose_rename`, `delver_propose_comment`, `delver_propose_tag`, and
`delver_report_finding`. Each accepts a bounded batch, validates the complete
batch before retention, requires model attribution, and writes only provisional
state. The interpretation tools append `proposed` edits; the finding tool appends
dedicated findings with severity, confidence, described image ranges, model
authorship, and reporting-call provenance. Both work on offline projects because
their anchors use content identity rather than live bytes. Named projects persist
findings immediately in SQLite schema v6, while untitled projects enter the
existing dirty/Save lifecycle. Once a write begins, the bounded batch completes
so dispatcher cancellation cannot conceal a successful prefix. The generated
chat/DTP/MCP catalog now contains twenty-three tools; MCP marks these writes
non-read-only, non-destructive, and non-idempotent.

P3c step 1 is done: proposed and rejected interpretation is a complete state
rather than an enum nothing could leave. A review decision is an ordinary
append carrying `resolves`, so invariant 5 holds — nothing mutates, and a
proposal is pending exactly while no later append decides it. Accepting copies
the proposal's anchor, op, and value under the *reviewer's* authorship, with the
model's proposal still readable one `resolves` hop away; rejecting records what
was declined and leaves the picture untouched. `resolves` is deliberately not
`compensates`: undoing an effect the picture had and declining one it never had
read identically if they share a field, and the review surface has to tell them
apart. [ADR 0006](../history/adr/0006-proposal-resolution-in-the-edit-log.md)
records the decision and the two alternatives that lost.

`propose`, `pendingProposals`, and `resolveProposals` are on the interpretation
service. Batch review builds every resolution against the pre-batch log before
appending anything, so an invalid mixed batch writes nothing. Valid decisions
remain independent append-only records, and an I/O failure may commit a prefix.
Appending a resolution fails closed
on an unknown, non-proposed, or already-decided sequence; replaying a stored log
stays tolerant of the same references, because a log naming a sequence it does
not contain is still the user's work. The field round-trips through the JSONL
record and is resequenced along with `compensates` on import.

P3b's integration assets are published. `Docs/development/external-agents.md` is
the client-facing surface: the generic stdio `.mcp.json`, the staged adapter
paths for development and packaged builds, per-client arrangements for Claude
Code, Codex, Cursor, Kimi, Delver's own workbench, and a minimal reference
client, the lazy discovery/approval sequence, and a troubleshooting table keyed
to the adapter's real error strings. It states plainly that none of those clients
has been through the conformance run yet, so the recipes are not mistaken for
verified ones.

A **Copy External Agent (MCP) Configuration** command now generates that recipe
rather than asking a human to transcribe two absolute paths. It resolves the
staged `delver-mcp` binary through the same Delver-owned candidate scheme the
relay uses — never a `PATH` fallback — and takes the root from the window's own
selection. Its eligibility check *is* activation's: `describeBridgeEligibility`
returns the single reason a window cannot publish, and
`isWorkspaceSelectionEligibleForBridge` is now derived from it. Two gates that
could disagree would produce the worst outcome available here — a copied
configuration for a window whose bridge is permanently inert — so there is only
one. Untrusted, remote, untitled, zero-root, multi-root, non-local, unsupported-
platform, and unstaged-adapter cases each yield their own localized sentence
instead of a generic failure.

P3a's contract and direct vertical slice exist. `IDelverAgentService` is the
single place an agent capability is implemented: the built-in chat tools call
it now, and the P3b command gateway, MCP adapter, and Python client will call
the same `invoke`. Adapters translate protocol and nothing else — the moment
one of them resolves a function boundary for itself there are two analysis
implementations that disagree, and the disagreement surfaces as a model citing
an address no pane ever showed.

Twenty-six capabilities are live: session info, capability discovery,
current context, focus, image info, function listing and lookup, RVA/VA/file
address conversion, disassembly, raw byte reads, wildcard search, instruction-aware
signature generation, offline named-signature listing, evidence-gated signature
persistence, decompilation, both xref
directions, string listing and search, imports,
exports, interpretation lookup, review-only rename/comment/tag proposals, and
evidence-backed provisional findings.
Every result is a versioned envelope
carrying byte identity, revision, provenance, and `completeness`, so a
truncated answer cannot be read as a complete one.

The stable contract now distinguishes malformed requests with
`INVALID_ARGUMENT`; `ADDRESS_NOT_MAPPED` is reserved for syntactically valid
addresses with no decoded mapping. Direct prompt references retain their full
`#delver_...` names so generic tools from another extension cannot collide.
Dispatcher and direct-tool telemetry now records dispatch, backing-service,
serialization, adapter transport, and model-visible total durations. The events
contain only bounded capability/outcome metadata and measurements, never sample
paths, hashes, arguments, model ids, or extracted content.

P3b now has its private renderer command gateway. `_delver.agent.capabilities`
and `_delver.agent.invoke` are the only extension-host entry points, and both
delegate directly to `IDelverAgentService`. The gateway validates a bounded
plain-JSON request before dispatch, rejects cycles, non-finite numbers, bigint,
oversized/deep payloads, unknown top-level fields, and spoofed caller kinds, and
returns stable failures as JSON data rather than lossy remote exceptions. It
opens no target, starts no analysis, and owns no capability logic. Cancellable
bridge calls multiplex `invoke` and `cancel` operation envelopes through the
existing invoke command, with bounded request ids and active-call counts; a
third private command was not added.

The built-in `delver-agent-bridge` extension now has the first external-
transport slice: bounded `Content-Length` framing and a transport-independent
authenticated DTP connection state machine. It accepts only `initialize`,
`agent/capabilities`, `agent/invoke`, and `agent/cancel`; binds caller identity to the
authenticated connection; rejects duplicate ids and excess concurrency; and
propagates explicit cancellation and disconnects into the renderer before
suppressing late writes. The shared Rust transport now bounds
headers, JSON payloads, and bulk binary frames before allocation and rejects
duplicate or non-decimal length headers.

The `delver-agent-relay` Rust executable now provides the thin OS
boundary needed by the bridge: one owner-only named pipe/Unix socket connection
is copied byte-for-byte to stdio and the process returns when either direction
ends. Windows retains `FILE_FLAG_FIRST_PIPE_INSTANCE` through the first accept,
rejects remote clients, and keeps its current-user DACL. Unix refuses existing
socket paths and requires a current-user-owned mode-0700 parent. Readiness is one
exact bounded JSON line on stderr; stdout remains protocol bytes only. The relay
is staged with the other native binaries and starts only for a trusted,
single-root local workspace.
Its opt-in bootstrap mode now queries the connected peer from the kernel—named-
pipe client PID on Windows, `SO_PEERCRED` PID/UID on Linux/Android, and peer UID
on BSD-family systems—and emits one bounded control record before starting byte
copying. Normal DTP mode emits no peer metadata.

The extension-side supervisor and backpressure-safe stdio transport are now
composed by the production activation owner. The
supervisor resolves only Delver-owned absolute binaries, creates a fresh
endpoint/token per attempt, strips ambient credentials from the relay process,
requires strict bounded readiness within five seconds, drains but never logs
post-readiness stderr, bounds queued writes to 8 MiB, and deduplicates
error/exit cleanup and capped exponential restarts. Credential handoff to an
independently launched MCP adapter now has a live bootstrap protocol core: one bounded
claim must match the registry entry, window instance, and canonical root
fingerprint; verified-peer authorization defaults to deny; DTP is provisioned
before a 15-second, 256-bit lease is issued; and atomic endpoint-generation-bound
consumption rejects replay. Disconnect, write failure, endpoint death, expiry,
and disposal revoke unconsumed leases. A concrete in-memory authorizer now holds
at most one 30-second approval for the currently connected, OS-attested peer.
Each request has a fresh opaque ID; disconnect, expiry, denial, disposal, and
stale approvals fail closed, so PID reuse cannot inherit authorization. The
localized modal adapter now offers only **Allow Once** and **Deny**,
shows OS-attested PID/UID separately from the explicitly unverified application
name, and grants only the exact live request ID. Dismissal, prompt failure,
expiry, disconnect, and adapter disposal deny; a stale unresolved modal also
prevents prompt stacking. Client display names containing control or bidi
formatting characters are rejected before authorization. `activate()` publishes
no endpoint until all eligibility and security gates pass.

The bootstrap relay manager now owns the race between the native
relay's stderr attestation and stdout claim bytes. It attaches a combined,
bounded READY/PEER decoder and a one-claim input gate before invoking the
publication seam. Publication is one-shot and is removed before buffered claim
fragments are released to a verified-peer bootstrap session. Cross-stream
arrival order, reentrant publication, oversized input, readiness/peer timeout,
response-write backpressure, and idempotent cleanup are covered in both injected
tests and production activation.

The non-secret rendezvous registry format and file store are now
implemented. Each publication is one immutable, bounded JSON file with a fresh
entry/window generation, root fingerprint, local bootstrap endpoint, owner PID,
and the relay's absolute peer deadline; it contains no token, nonce, path, target
metadata, or client label. Same-directory temp write/fsync plus atomic no-replace
link publication avoids a shared manifest and cross-window locking. Readers cap
enumeration and per-file allocation, reject malformed/future/expired/wrong-
platform entries, and prune only well-formed expired entries or old temp files.
Disposing one window removes only its exact entry. POSIX preparation requires
the four Delver-owned directories to be current-user 0700 and creates each
component only after checking the previous one. Windows now has an audited native
provider in `delver-agent-relay --prepare-registry-directory`: every owned
component is opened without following reparse points and must have the current
token user as owner plus one exact, protected, inheritable full-control ACE for
that SID. New components receive that descriptor at creation; mismatched
existing directories are rejected, never repaired. The TypeScript one-shot
controller supplies only whitelisted `LOCALAPPDATA`/Windows boot variables,
requires empty stdout, one bounded exact readiness record, clean exit, and a
five-second deadline. Production activation injects this provider on Windows
and uses strict owner/mode validation on POSIX.

The `root-v1` module now gives the extension and future MCP adapter one
normative workspace-routing fingerprint. It requires exactly one local,
non-remote, non-untitled directory, resolves filesystem aliases before hashing,
uses strict platform-specific canonical forms with no Unicode normalization,
and locks the domain-separated SHA-256 preimage with drive, UNC, POSIX, and
composed/decomposed Unicode vectors. Unsupported platforms and malformed,
missing, inaccessible, non-directory, or ambiguous roots fail closed. The
fingerprint contains no path and remains routing metadata rather than identity.

The per-window rendezvous lifecycle is now production-composed behind the
startup activation gate. Bootstrap sessions and relay attempts expose first-wins close outcomes;
silent or partially framed peers have a five-second claim deadline; authorization
distinguishes grants, denial, expiry, cancellation, busy suppression, and an
unavailable verifier. Registry removal is awaited before buffered claim bytes
are released, and shutdown waits for in-flight publication and endpoint cleanup.
Token-free lease events let the lifecycle block publication while a credential
is live, penalize an unconsumed/invalidated grant, and reset counters only after
successful DTP initialization consumes the token. One scheduling gate serializes
root generation changes, stale modal prompts, active leases, asynchronous
teardown, and ±20% jittered idle/technical/prompt backoff. Rapid root changes
rotate IDs and cannot resurrect an old publication. Every root refresh first
unpublishes bootstrap, aborts pending provisioning, and closes authenticated
private DTP relays before applying the next fingerprint. Extension shutdown
awaits registry removal, native process exit, and endpoint cleanup.

Production activation now runs on `onStartupFinished` but remains inert for
Restricted Mode, remote/virtual/untitled workspaces, unsupported platforms, and
zero or multiple roots. A real workbench launch verified that Restricted Mode
creates no registry, granting trust publishes one token-free 30-second entry,
and closing the window removes the entry and reaps the relay.

The gated real-process path now passes on Windows: a raw Node client claims the
real bootstrap pipe, receives an explicitly granted 256-bit one-time token,
connects a second real relay, initializes DTP, reaches capabilities/invoke, and
cancels the pending renderer request on disconnect. That test exposed two native
duplex bugs that unit-memory streams had hidden. The relay now flushes every
forwarded chunk, and the Windows server polls pipe availability before reading
so a pending synchronous read on a duplicated handle cannot serialize and
deadlock the response write. The Windows writer flushes kernel pipe buffers
before considering delivery complete.

The standalone native `delver-mcp` adapter is now implemented and staged with
the other Delver binaries. It requires an explicit absolute `--root`, computes
the same root-v1 fingerprint as the extension, strictly selects one current
registry publication, performs the one-shot bootstrap claim, consumes the
private DTP token, and keeps one authenticated session for dynamic tool calls.
Its stdout is bounded UTF-8 MCP JSON-RPC over newline-delimited stdio; it
negotiates public protocol revisions through `2025-11-25`, enforces initialize
lifecycle, keeps ping responsive while tool workers run, maps MCP cancellation
to `agent/cancel`, suppresses late responses, and bounds shutdown even when a
backend does not cooperate. The gateway capability response now carries the
canonical title, model description, and input schema for all sixteen tools, so
the adapter does not duplicate TypeScript tool definitions. Successful calls
preserve the full Delver result envelope as text and structured content; stable
Delver failures remain MCP tool errors rather than protocol errors.

Discovery costs nothing. `delver_capabilities` answers with no project open and
starts no target, no analysis, and no decompiler — the plan's hard performance
rule, and now an asserted one rather than an intention. Saved pseudocode is
likewise a zero-backend hit: an offline `.delverdb` answers `delver_decompile`
from the project while `delver_disassemble` and the xref capabilities report
`TARGET_NOT_ATTACHED`, which tells an agent to ask for the sample rather than
conclude the function is empty.

Pagination cursors are bound to the content hash, revision, capability, **and**
the filter arguments that produced the sequence. Byte binding was designed in;
filter binding was not, and was found by the test pass — an offset into the
functions matching `crypt` is meaningless against those matching `alloc`, and
reusing it skips and repeats rows with nothing in the result to say so. Both
now fail as `STALE_REVISION` instead.

Addresses cross the boundary as canonical lowercase `"0x..."` strings in both
directions. A JSON number above 2⁵³ is rejected outright rather than mapped to
a nearby instruction, since by the time it reaches the dispatcher the precision
is already gone.

Sample-derived payloads — strings, symbol names, pseudocode identifiers — are
labelled `untrusted` in provenance, and the tool layer prepends a separate
warning part so a payload that quotes or truncates cannot swallow it.

The direct tools register into a `delver-analysis` tool set built from the
dispatcher's own capability list, so the chat picker cannot advertise a
capability the dispatcher lacks. `delver_capabilities` is the only tool without
a `delverTargetOpen` `when` clause.

Generated function names are now backend-neutral and image-relative throughout
the UI and pseudocode: unnamed entries display as `SUB_<RVA>`, and PyGhidra C
output rewrites only Ghidra-generated `FUN_<VA>` identifiers by subtracting the
program image base. Meaningful backend symbols and analyst-authored names remain
unchanged, while legacy lower-case `sub_` project placeholders are still
recognized as generated names. The Ghidra Program itself is not renamed.

Pseudocode failures now expose copyable diagnostics plus explicit Retry and
Restart Decompiler actions. Retry bypasses read-through caches for that exact
function. Restart cancels active PyGhidra operations, disposes the persistent
worker, starts a fresh process generation through the backend-neutral IPC seam,
and only then re-decompiles; existing saved pseudocode remains durable if
recovery fails.

Native decompiler cache inspection and cleanup are now explicit Command Palette
actions. Inventory reports the fixed cache path, Ghidra project count, files,
and total bytes without starting a backend. Cleanup requires confirmation,
cancels active work, disposes PyGhidra, validates that the recursive-delete
target is the absolute `delver/decompiler-cache` directory, and never touches
portable `.delverdb` files. Live pseudocode provenance shows request duration;
the latest-performance action breaks out startup, handshake, target analysis,
function recovery, decompilation, and serialization timings.

Live sessions now prepare PyGhidra in the background before the first F5:
worker startup, target hash verification, and persistent project/program import
begin as soon as the session opens, with delayed status-bar progress. Target
opens are coalesced by session and content hash, so an F5 arriving during
preparation joins the same operation and cannot enqueue a duplicate Ghidra
import. Full auto-analysis is deliberately not scheduled yet because Ghidra
would monopolize the single JVM-owning thread and could make interactive F5
slower; it needs an interruptible, resumable scheduling design first.

Pseudocode-to-listing synchronization now preserves exact discontiguous source
ranges. The focus bus carries those half-open ranges alongside its legacy
contiguous bounding selection, and the virtualized listing highlights only
instructions whose `[RVA, RVA + length)` overlaps a real source range. Gaps
between blocks stay unpainted, newly materialized rows read the current ranges,
and location-only navigation clears stale semantic highlighting.

Function revision comparison now has a bounded backend-independent primitive in
`platform/delver/common/functionRevisionMatcher.ts`. It creates versioned SHA-256
fingerprints from listing rows, ignoring row/RVA movement and representing direct
targets as local instruction indices or external edges. Matching accepts only a
fingerprint unique in both revisions; repeated thunks remain ambiguous. Results
carry confidence, method, source/target content hashes, and fingerprint
provenance. Structural fuzzy matching and instruction-level remapping remain
explicit future work.

Portable projects now use revision-aware SQLite schema v6. Explicitly opening
the same target path probes the current bytes and, when their SHA-256 changed,
offers Add as New Revision / Create New Project / Cancel. Adding a revision is
atomic and preserves every prior snapshot. The analysis server emits normalized
function fingerprints; unique exact matches are stored with confidence and
provenance, then existing names, comments, and tags are copied as attributed
import edits only when the destination has no authored value. Ambiguous or
changed functions are left untouched, and decompiler output is regenerated.
Schema-v1 and schema-v2 projects upgrade in place without losing their initial
analysis. The `findings` table retains one validated payload per finding and
binds it to the matching target revision; v4 added one append-only human decision
per finding without rewriting the original model-authored payload, and v5 adds
bounded dispatcher exchanges keyed by revision and call id.

Session persistence is now specified as a portable, IDA-like project lifecycle.
Opening a raw binary creates an untitled session. Once durable analysis content
exists, close, target replacement, and shutdown prompt Save / Don't Save /
Cancel. Saving creates a user-chosen `.delverdb`; named projects then autosave
incrementally. The single SQLite file retains functions, strings, facts,
pseudocode, interpretation, findings, provenance, and useful session state, but
never sample bytes, and it can open without the original target.

ADR 0005 supersedes the current per-content-hash JSONL location decision. The
existing JSONL implementation is now a migration source, not the future project
format. Ghidra projects remain content-hash-keyed local user-data caches qualified
by backend version and analysis profile. They are disposable, nonportable
accelerators; `.delverdb` is the backend-neutral record of analysis and user
work. Future IDA native databases follow the same boundary.

The production decompiler direction is now a backend-neutral persistent host,
with isolated workers per engine. The first PyGhidra adapter keeps one JVM plus
an analyzed Ghidra Program and DecompInterface alive across function requests. The current
headless Ghidra path remains a compatibility fallback. The future IDA adapter is
now specified as a Python IDALib (`idapro`) worker targeting a user-provided IDA
Pro 9.0+ and appropriate Hex-Rays license. It uses the existing IDAPython APIs
outside the GUI, serializes every database operation on IDALib's initialization
thread, and may restart the isolated worker for hard cancellation. It adapts
Hex-Rays text, variables, diagnostics, and ctree/eamap-derived line↔RVA
provenance through the same host protocol without sharing a runtime with
PyGhidra. IDBs stay content-hash/version/profile-qualified local accelerators;
p-code, microcode, and ctree remain optional backend-specific capabilities.

The versioned JSON-lines host and PyGhidra worker are implemented. The shared
process supervises one worker, negotiates backend identity and capabilities,
multiplexes requests, forwards cancellation, retains targets per analysis
session, clears stale target state after a worker restart, and falls back to the
one-shot headless backend only when discovery or the initial handshake fails.
Errors from a successfully started backend are reported directly instead of
triggering a second slow decompilation. The Python worker verifies the target's
SHA-256, serializes all Ghidra work on the JVM-owning main thread, and reserves
stdout exclusively for protocol frames.

P2a now has an injectable `IDelverDecompilerService` boundary. Its stable result
shape carries C text, recovered variables, backend identity, and one-based source
lines mapped to discontiguous half-open RVA ranges. Bidirectional lookup helpers
handle overlapping mappings without flattening provenance. The registered
scaffold reports unavailable explicitly until the headless Ghidra backend lands,
and cancellation is rejected before invoking a backend.

The Ghidra adapter now pins the scaffold to Ghidra 12.1 and strictly decodes a
versioned JSON wire format. RVAs remain hexadecimal strings until validation, so
addresses above `2^53` retain precision. Unknown fields, incompatible schema
versions, invalid ranges, and output for the wrong function are rejected. The
node-side backend boundary discovers the configured platform launcher and
bundled script, reports actionable unavailable states, forwards cancellation to
an injected runner, and validates its response before exposing it to consumers.

The scaffold is now executable end to end through the shared process. The
`DelverDecompile.java` post-script uses the pinned 12.1 API to emit pseudocode,
recovered high variables, and merged line provenance. Each request copies the
target into an isolated temporary project, verifies that snapshot against the
session SHA-256, launches without interpolating target paths into a shell command,
kills the full process tree on cancellation, and removes the project afterward.
`delver.decompiler.ghidraHome` is a machine-scoped setting; without it the service
continues to report the backend as unavailable.

The official Ghidra 12.1 distribution has now been exercised end to end on
Windows against `provider-file.exe`. The entry function produced schema-v1 JSON,
160 characters of pseudocode, three line mappings, and two recovered variables.
That smoke test corrected the pinned `HighSymbol` storage call to `getStorage()`;
a source-level regression test now prevents the nonexistent
`getVariableStorage()` call from returning.

Functions now open a read-only `delver-pseudo:` editor for the selected RVA.
The editor uses Monaco's existing C mode so syntax coloring, folding, find, and
the normal code-editor navigation work without a second grammar. Moving its
cursor publishes the line's first instruction plus the bounding recovered RVA
selection; focus changes from the listing move the pseudocode cursor back to the
first matching line. The unavailable-backend path stays inside the editor and
points directly to the Ghidra 12.1 setting instead of failing the open command.

Overview now acts as the workspace table of contents: Entry Point publishes its
wire-safe RVA through the focus bus, Instructions opens the listing, Functions
and References reveal their panes, and Strings opens its editor page. The row
model is separated from contribution registration and has a focused navigation
contract test, including an address above `2^53`.

Built-in extension synchronization now keeps `vscode-js-profile-table` on its
official GitHub release asset. Open VSX serves different bytes for version
1.0.11, while both Microsoft Marketplace and the official GitHub release match
the upstream-pinned SHA-256; the integrity pin remains unchanged.

Fresh development checkouts now build the Rust provider and analysis server
during pre-launch when their debug binaries are absent. Release staging includes
`server-analysis`, and a missing executable reports its spawn error immediately
instead of masquerading as a ten-second listener timeout.

Functions and Imports filters now keep their input visible when a query has no
matches. Filtered-empty state no longer activates the view welcome overlay, so
clearing or editing the query always restores matching rows. Filtered roots use
search-only tree identities, preventing automatic search expansion from leaving
every normal module or function group open after the query is cleared.

Functions and Imports now have persistent, debounced filter boxes. Function
filtering covers authored/placeholder names, RVAs, and source across the complete
set; Imports covers modules, symbols, ordinals, and IAT RVAs.

The Functions pane no longer stops after 1,000 swept entries. Large categories
are exposed as lazy 1,000-row pages, so all ~178k results remain reachable while
each expansion and refresh stays bounded. Rename refresh is now incremental and
does not rescan every function for comment or tag edits. Strings already lives in
an editor page with its own filter and encoding column, completing G6.

The listing now renders authored names at any RVA and comments after the operands
on their instruction line. Function starts retain their placeholder/authored landmark
line. Interpretation is owned by the real instruction row rather than inserted
as synthetic analysis rows, so paging ordinals and address mapping stay exact.

Each label is one bounded display line and adds one deterministic line height;
comments do not change row height. Imported multiline comments fold newlines only
for display while the stored value remains unchanged. Accepted edits re-splice
only their buffered row, updating immediately while preserving focus and selection.

`;` opens Set Comment while a listing row is selected; input focus suppresses the
shortcut so semicolons can be typed into the prompt. Empty input clears by
appending an empty-value edit. F2 Rename and Set Comment share one editing path.

Function rows now carry wire-safe RVA handles. Rename is an inline row action and
Set Comment is in the row context menu; both update the listing and Functions pane
through the interpretation event.

Tags are stored as canonical arrays and render inline as `#tag` tokens. `T` edits
the selected instruction's tags. Imports, addressed Exports, References, and
Functions expose the same Rename, Set Comment, and Set Tags row actions; forwarded
exports remain excluded because they have no RVA in this image.

`Ctrl+Z` now undoes local interpretation with an attributed compensating append.
It walks backward through uncompensated accepted edits without rewriting history.
`Delver: Revert Interpretation by Author...` reconstructs state without one
author's accepted edits and appends one compensation per affected field. Merged
imports are resequenced so compensation references remain unambiguous.

Listing navigation also maps Mouse4/Mouse5 to the existing focus-history
back/forward stack. The events are captured before the table or Chromium can
consume them, and Alt+Left/Alt+Right remain equivalent keyboard paths.

References now render proven function-relative locations such as
`decrypt_config+0x2A`, with the raw RVA and reference kind in the description.
Exact entries use the function name; addresses without a known containing range
remain raw rather than being attributed to a guessed owner. Renames refresh the
pane immediately.

The inline-row decision is recorded in [p1-plan.md](p1-plan.md), and the listing
height constraint is updated in [ide-architecture.md](../architecture/ide-architecture.md).

Function names on listing landmark lines are now the product accent instead of
`symbolIcon.functionForeground`, through a registered `delver.listing.functionName`
color. Registering it exposed that the other four `delver.listing.*` IDs are
declared in the theme files but never registered — a theme entry for an
unregistered ID emits no CSS variable, so those four roles currently do nothing.
The listing's mnemonic and branch-target colors still borrow
`debugTokenExpression.*` and `textLink.foreground`. See
[rebranding-plan.md](rebranding-plan.md) §2.1.

Separately, the rebrand had replaced only the OS artwork under `resources/`, so
every renderer-drawn surface still showed the VS Code logo — most visibly the
titlebar app icon. Those come from source-tree SVGs
(`browser/media/code-icon.svg` and the four `letterpress-*.svg` watermarks), which
`scripts/generate-artwork.py` now traces from `resources/delver/logo.png` along
with the OS icons, so the whole set regenerates from one master.

## Verification

- Signature UI/migration focused run: 25 passing, covering generation policies,
  earlier-revision classification and promotion gating, SQLite `signature`
  mappings, retained proof validation, conflict-preserving annotation transfer,
  idempotent Review proposals, and fail-closed single/bulk IDAPython generation
- Agent dispatcher and contract: 32 passing. They cover zero-analysis
  discovery, per-capability missing-project handling, attachment refusal, the
  zero-backend saved pseudocode path, an address above 2⁵³, unsafe JSON
  numbers, count clamping, cursor binding to bytes/capability/filter,
  containing-function resolution including padding after a known end, offline
  RVA/VA/file-offset conversion including virtual zero-fill tails, bounded
  image/file byte reads with exact little-endian integer decoding, wildcard
  scans across provider chunks, overlapping matches, revision-bound search
  cursors, complete negative scans, short-read refusal, instruction-aligned
  relocation-stable signatures, bounded uniqueness proofs, retained-evidence
  cross-revision proofs and fail-closed mismatches, proven xref-site fallbacks,
  evidence-gated named signature saves, and offline named-signature listing,
  untrusted string labelling, authored names beating placeholders,
  cancellation, envelope shape, attributed offline rename/comment/tag
  proposals, validation-atomic malformed batches, and the write commit boundary
- Agent tool presentation: 3 focused tests cover catalog/tool identity, exact
  byte/address and signature schemas, and bounded review-only proposal schemas;
  generated discovery reports 26 tools
- Named-signature/project focused run: 57 passing (10 SQLite store, 4 project
  service, 32 dispatcher, 3 tool-definition, and 8 command-gateway tests),
  including v1-to-v6 migration, reopen, per-revision isolation, atomic upsert,
  and case-insensitive replacement with a stable id
- Session/decompiler regression run: 41 passing
- Provider/analysis session: 7 passing, including verified image-RVA and raw
  file-offset binary-frame reads
- Proposal review state: 5 log-level tests (proposal invisible to the view but
  present in the log, acceptance authored by the reviewer with the proposal
  traceable, rejection recording the declined value, fail-closed resolution of
  unknown/non-proposed/already-decided sequences, replay restoring pending and
  decided state), 2 service-level tests (persisted proposal then decision, and a
  invalid batch that writes no resolutions), and 1 store test covering resequenced `resolves`
  references and refusal of a malformed one
- MCP client configuration: 5 focused tests covering absolute-path binding,
  optional untrusted-label validation, rejection of relative paths and
  control/bidi or oversized labels, the exact pasteable serialization, staged
  adapter resolution with no `PATH` fallback, and one distinct availability
  reason per ineligible window shape
- Private command gateway: 8 passing, covering the two-command surface,
  canonical delegation, JSON round-tripping, structured failures, bounded
  request/operation validation, cancellation propagation, and idempotent
  cancellation multiplexing
- DTP bridge, relay supervision, bootstrap manager, authorization UI, root fingerprinting, rendezvous lifecycle/registry, production activation, private relay ownership, and leases: 95 passing, covering fragmented/coalesced bounded framing,
  malformed and oversized input, authentication, caller binding, pre-init
  refusal, duplicate ids, concurrency limits, out-of-order correlation, and
  explicit/disconnect cancellation with late-write suppression; absolute
  executable resolution, 256-bit token rotation, credential-free child
  environments, strict readiness, backpressure, overflow/error closure,
  restart backoff/stability reset, dispose/no-respawn, default-deny and exact
  one-shot peer authorization, PID-reuse isolation, platform identity checks,
  modal allow/deny/dismiss/failure behavior, exact-item grant identity,
  stale-modal prompt suppression, verified/untrusted prompt labelling, and
  control/bidi display-name rejection,
  exact window/root routing, provisioning order, failure
  revocation, TTL boundaries, one-time consumption, replay rejection, strict
  peer-control decoding, cancellation before attestation, publication/listener
  ordering, cross-stream claim buffering, bounded pre-attestation input,
  truthful response-write backpressure, and one-shot unpublication;
  lock-free multi-window registry publication, strict non-secret schema and
  platform paths, atomic collision refusal, bounded stale/malformed filtering,
  selective pruning, relay-deadline propagation, and late-publication cleanup;
  exact native-helper arguments/environment, fragmented bounded readiness,
  stdout/extra/oversize/nonzero/timeout/cancellation refusal, and path matching;
  focused extension compile and ESLint clean
- Shared Rust DTP transport: 15 passing, including owner-only listener
  round-trip, first-instance namespace reservation, remote-client rejection in
  the bind flags, header/JSON/binary size enforcement before allocation, and
  protected private-directory creation, reaudit, concurrency, and file-component
  rejection
- Rust agent relay: 2 passing bidirectional byte-transparency/lifecycle and CLI-mode tests;
  the same connection asserts the OS-derived peer identity, and the executable
  emits exact JSON readiness only after a successful bind
- Live Windows relay smoke: readiness followed by an opt-in peer control record
  whose kernel-reported named-pipe client PID matched the connecting process;
  relay exited after disconnect
- Real bootstrap→private-DTP process integration: 1 passing, covering in-memory
  publication, kernel peer identity, explicit one-shot authorization, private
  relay provisioning, 256-bit lease handoff/consumption, DTP initialization,
  gateway caller binding, disconnect cancellation, both child exits, and
  consumed-bootstrap reconnect refusal
- Real Windows registry-helper integration: 1 passing, covering protected native
  hierarchy creation/reaudit followed by actual file-registry publish, list, and
  disposal; the legacy bootstrap process integration still passes unchanged
- Tool reference contract: 1 passing; every prompt reference retains its full
  globally unambiguous `delver_...` capability id
- Isolated workbench: the renderer registers exactly `_delver.agent.capabilities`
  and `_delver.agent.invoke`; no third `_delver.agent.*` command exists. All 16
  compiled chat definitions expose their full `delver_...` ids as prompt
  references
- Live workbench, `provider-file.exe` (5,282 functions, 203,588 instructions),
  Claude Haiku 4.5 in the built-in chat:
  - all 16 tools plus the `delverAnalysis` set register; with no target open
    only `delver_capabilities` and the set are offered, and the remaining 15
    appear once a target opens — the `delverTargetOpen` clause holds in both
    directions
  - `delver_capabilities` reported 16 capabilities, 4 core / 12 analysis, and
    an unconfigured decompiler with its actionable reason rather than a
    generic failure
  - a real investigation resolved `SUB_1000`/`SUB_1350`/`SUB_1510`, decoded the
    x86-64 prologue at `0x1000` with exact instruction lengths, and attributed
    the single xref as `SUB_1350+0x113` (`0x1463 − 0x1350`, confirmed by hand)
  - the model reported `list_functions` and `disassemble` as partial and
    `xrefs_to` as complete, which is the envelope doing the job it exists for
  - **not yet exercised:** decompilation (Ghidra home unset in this profile),
    the offline `.delverdb` path, and the §4 latency budgets
- Targeted ESLint on the agent service, contract, tests, and both `delverAI`
  contribution files: clean. The custom `delver-address-is-bigint` rule caught
  pagination indices named `offset`, which reads as an address offset in this
  codebase; they are now `startIndex`/`nextIndex` rather than suppressed
- Client typecheck: clean
- Generated function naming: 5 common tests and 8 Python worker tests passing
- Listing and reference placeholder presentation: 6 passing
- SQLite snapshot, revision, migration, and finding persistence: 9 project-store tests passing
- Tool-call record validation and JSON round-trip: 3 passing
- Finding/decision domain validation and 64-bit wire round-trip: 4 passing
- Project finding/tool-call lifecycle and autosave: 4 passing
- Review tree projection, evidence navigation, and tool-result document: 4 passing
- Agent dispatcher: 28 passing, including retained exchanges and validated finding citations
- Generated chat/MCP tool definitions: 3 passing with a twenty-tool catalog
- Decompiler recovery/restart service: 14 focused tests passing
- Cache cleanup boundary: 1 focused filesystem test passing
- Decompiler cache/performance service: 15 focused tests passing
- Background target preparation: 5 PyGhidra adapter and 16 service tests passing
- Discontiguous focus/highlighting: 13 focus-bus and 2 range tests passing
- Client typecheck and transpilation: clean
- Native MCP adapter: 20 Rust tests passing; Clippy clean with warnings denied
- Agent bridge: 95 unit tests and 2 real-process integration tests passing
- Build-tool typecheck: clean with `delver-mcp` staged and marked executable

- Function revision normalization/matching: 8 passing; targeted ESLint clean
- Revision-aware SQLite store and v1 migration: 8 passing
- Updated-target prompt/session lifecycle: 19 passing
- Interpretation model/service/store, listing presentation, and handles: 25 passing
- Mouse history mapping plus focus-history behavior: 12 passing
- Function-relative reference labels: 2 passing
- Functions paging/filtering and Imports filtering: 9 passing
- Listing paging/model: 12 passing
- Functions interpretation handles: 2 passing
- Overview navigation contract: 1 passing
- Targeted ESLint: clean on all changed interpretation and pane-action files
- Client typecheck: clean
- Build-tool typecheck: clean
- Fresh native debug build: `provider-file` and `server-analysis` staged
- Missing-provider startup error: 1 passing
- Decompiler contract, protocol validation, worker lifecycle/discovery, IPC
  bridging, cancellation, caching, and line maps: 21 passing
- Python worker protocol and JPype compatibility: 5 passing
- Real persistent Ghidra 12.1 / PyGhidra 3.1.0 smoke: handshake in about 3 s;
  one target analysis plus two successful `0xd8580` decompilations in one
  77.5 s worker lifetime
- Pseudocode line/focus mapping: 2 passing in Chromium
- Real Ghidra 12.1 headless smoke: schema v1, `0xd8580`, 3 line mappings,
  2 recovered variables
- Isolated workbench check: opening `provider-file.exe`, expanding Functions,
  and clicking `sub_1000` opened a full-size `Pseudocode: sub_1000` editor with
  the expected Ghidra configuration guidance
- Existing navigation test cannot run in the Node harness because its EditorPane
  import reaches CSS; this is a harness limitation, not a test assertion failure.

## Next

P3c continues with graph-path evidence and bulk review operations. The static
baseline now retains proposals/findings and
their cited tool results, lets a human decide them, and navigates concrete range
evidence. Next add the bytes/search and program-graph capabilities needed to
make deeper evidence retrievable without reconstructing it from hundreds of
narrow calls.

For P3b, root-v1, the per-window lifecycle/backoff owner, production extension
composition, approval adapter, root-scoped private relay ownership,
`onStartupFinished` activation, and the native stdio MCP adapter are complete.
The generic `.mcp.json`, client recipes, and the configuration-generating
command are published. Next run the same real-binary workflow through Codex,
Claude Code, Kimi, Cursor, and the minimal reference client. Add cross-transport result conformance and latency
measurements before calling P3b complete. Dynamic `tools/list_changed` and
operation progress remain deliberately unadvertised until DTP has real events;
the adapter does not synthesize capabilities it cannot observe.
The two-command cancellation path, owner-only relay, peer attestation,
connection-bound authorization primitive, supervisor, race-safe one-shot
bootstrap manager, bootstrap validation, single-use lease primitive, and real
bootstrap-to-DTP process conformance are complete.

In parallel, finish the one remaining P3a acceptance check: open the real Auto-updater
`.delverdb` without its sample, ask built-in chat for saved pseudocode, verify no
provider or decompiler starts, then attach the matching sample and exercise live
decompilation. Capture the new stage measurements against the §4 budgets. The
direct live-session investigation and private command conformance suite already
pass.

Registering the tools means `contrib/delverAI` imports the chat contrib's
`ILanguageModelToolsService`, a knowing exception to invariant 9. There is no
other contribution point for language-model tools, and upstream's own
`browserView` contrib does the same; the exception is noted here so it is not
mistaken for drift.

The P2b project/decompiler integration slices now restore saved analysis
categories and pseudocode without a provider or Ghidra call, automatically
attach a saved in-workspace target only after SHA-256 verification, retain an
offline fallback plus manual Locate Target, and expose
actual backend state and phase timings. PyGhidra failure no longer silently
starts the minute-long headless path; headless selection is explicit.

Combined verification: session lifecycle 25 passing, decompiler/worker/status
29 passing, SQLite project store 10 passing, Python worker 6 passing, client
typecheck and transpilation clean.

Next, visually exercise Open Project, Locate Target, saved pseudocode provenance,
Close Project, explicit recovery, and explicit headless selection against the
real Auto-updater project. Then design interruptible/resumable full-analysis
scheduling or begin the backend-neutral IDA test-double boundary. The isolated launch helper was repaired for
Windows PowerShell parsing, but automated visual verification remains blocked
while the only complete source profile has a Chromium Cookies lock; EditorPanes
still have no unit UI harness in this fork.

After the host boundary is covered by backend-neutral contract tests, add an IDA
test double so Ghidra-specific names cannot creep back into the protocol. Exact
discontiguous pseudocode selection painting remains the next UI-side P2 slice.
Types remain a later interpretation extension; merge and conflict detection
remain collaboration work.

## Known limitation

Wrapped/unbounded source or pseudocode interleaving still needs a custom dynamic
list delegate. Comments deliberately remain bounded on the instruction line.
