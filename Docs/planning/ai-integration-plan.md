# P3 AI Integration Plan

This plan turns Delver's analysis, decompiler, project, focus, and
interpretation services into one agent capability surface. The primary path is
implemented inside the workbench and invokes those services directly. Standard
MCP is the vendor-neutral adapter for external agents, not the internal
architecture and not a second analysis implementation.

The intended result is an AI analyst that can investigate a large static binary
incrementally, retain its work in the project, show the evidence for every
claim, and resume without asking the decompiler or model to rediscover completed
work.

---

## 1. Outcome and limits

For an unpacked supported binary, an agent must be able to:

1. inspect the active project and current analyst focus;
2. triage functions, strings, imports, exports, and references;
3. retrieve saved or live pseudocode and exact supporting instructions;
4. build a persistent investigation worklist and hierarchical summaries;
5. propose names, comments, types, and findings in batches;
6. let a human review those proposals;
7. trace every retained conclusion to addresses and tool calls; and
8. resume the investigation, or adapt it to a matched binary revision, without
   repeating completed work.

Static analysis cannot reconstruct information erased by compilation and cannot
observe code or secrets produced only at runtime. Packed, encrypted,
self-modifying, environment-dependent, and anti-analysis samples eventually
require P4 execution, emulation, or debugging. P3 reports those boundaries as
unresolved findings rather than inventing answers.

The AI is not a decompiler or disassembler. It reasons over facts produced by
those systems and authors reviewable interpretation.

---

## 2. Architecture: one dispatcher, two transports

```text
                         Delver workbench

  Built-in chat agent ── ILanguageModelToolsService registration
                                      │
                                      ▼
                         IDelverAgentService
                       capability dispatcher
                     ┌────────┬────────┬────────┐
                     ▼        ▼        ▼        ▼
                  session  analysis decompiler project /
                    focus    facts     cache   interpretation
                     ▲
                     │ private `_delver.agent.*` gateway
                     │
             built-in Delver bridge extension
                     │ local DTP, named pipe / Unix socket
                     ▼
             vendor-neutral MCP adapter process
                     │
           Kimi / Claude / Codex / Cursor / any MCP client
```

The built-in path calls `IDelverAgentService` in the renderer and adds no
serialization or transport hop beyond service calls that already exist. The
external path adds transport only at the process boundary it must cross. It
still queries the active session, warm analysis index, memory cache, and loaded
`.delverdb`; it never opens a second target or constructs a parallel database.

Commands such as `delver.listing.decompileFunction` remain human actions. They
open editors, prompt, move focus, and often return no data. Agent tools instead
need typed inputs, bounded outputs, cancellation, pagination, provenance, and
stable error codes.

Only two private commands form the extension-host gateway:

```text
_delver.agent.capabilities
_delver.agent.invoke
```

They delegate to `IDelverAgentService`. No analysis logic belongs in a command
handler, MCP adapter, or extension host.

### Code ownership

```text
src/vs/workbench/services/delver/common/
  delverAgentService.ts             canonical contracts and dispatcher
  delverAgentTypes.ts               JSON-safe request/result envelopes

src/vs/workbench/contrib/delverAI/browser/
  delverAITools.contribution.ts     direct ILanguageModelToolsService tools
  delverAIToolDefinitions.ts        schemas, descriptions, tool sets
  delverProposalReview.ts           later proposal review surface

extensions/delver-agent-bridge/
  src/extension.ts                  private-command bridge and local endpoint

delver/delver-mcp/                  native stdio MCP-to-DTP adapter
delver/clients/python/              Python client over the same DTP methods
```

Do not add a public `vscode.delver` TypeScript API or modify `extHost.*` and
`mainThread.*`. The bridge uses the existing command RPC boundary and remains a
built-in Delver component.

---

## 3. Canonical service contract

`IDelverAgentService` owns capability discovery and invocation:

```ts
interface IDelverAgentService {
	readonly capabilities: readonly IDelverAgentCapability[];
	invoke(request: IDelverAgentRequest, token: CancellationToken): Promise<IDelverAgentResult>;
}
```

The dispatcher performs validation and policy once for every caller:

- active-session and revision resolution;
- address parsing and normalization;
- capability checks, pagination, and output limits;
- cancellation and time budgets;
- untrusted-data labelling and rendering sanitization;
- provenance and evidence-envelope construction;
- read/write classification and proposal attribution; and
- structured error conversion.

Adapters translate only their protocol. They must not special-case Ghidra,
recompute function ownership, inspect UI tables, or parse rendered pseudocode.

Every result uses a JSON-safe versioned envelope:

```ts
interface IDelverAgentResult<T> {
	readonly schemaVersion: 1;
	readonly callId: string;
	readonly capability: string;
	readonly project?: {
		readonly contentHash: string;
		readonly revisionId?: string;
		readonly projectPath?: string;
	};
	readonly provenance: readonly IDelverAgentProvenance[];
	readonly completeness: 'complete' | 'partial' | 'stale';
	readonly omitted?: { readonly count?: number; readonly reason: string };
	readonly nextCursor?: string;
	readonly data: T;
}
```

Addresses remain normalized `"0x..."` strings across JSON boundaries. Results
say when a string scan, graph walk, decompilation, or analysis is partial.
Opaque cursors include the content hash and revision so they cannot silently
continue against different bytes.

Stable error codes are:

```text
NO_ACTIVE_PROJECT       TARGET_NOT_ATTACHED       ADDRESS_NOT_MAPPED
FUNCTION_NOT_FOUND      CAPABILITY_UNAVAILABLE    ANALYSIS_INCOMPLETE
DECOMPILER_UNAVAILABLE  RESULT_LIMIT_EXCEEDED     STALE_REVISION
INVALID_ARGUMENT        CANCELLED                 CONFIRMATION_REQUIRED
INTERNAL_ERROR
```

Diagnostics may accompany errors, but agents branch on codes.

`INVALID_ARGUMENT` means the caller must repair its request: examples are a
non-hexadecimal address, an unsafe JSON address number, a missing required
field, or an empty search query. `ADDRESS_NOT_MAPPED` is reserved for a valid
address that does not resolve to decoded bytes; `ANALYSIS_INCOMPLETE` means the
requested fact is absent from the current analysis. Keeping these cases distinct
lets every adapter give the model the correct recovery instruction.

---

## 4. Performance design

The critical rule is **no analysis work caused by connecting an agent**.
Connection and discovery do not open a target, start Ghidra, scan strings, or
load every project row.

Warm active-project acceptance budgets, excluding explicitly requested backend
work:

| Operation | Target p95 |
| --- | ---: |
| Direct dispatcher overhead | < 2 ms |
| MCP/DTP adapter overhead for a small result | < 15 ms |
| Session metadata or current focus | < 20 ms |
| Cached listing or xref page | < 50 ms |
| Saved pseudocode lookup | < 50 ms |
| Live decompilation | Report backend phases; no fixed claim |

Record histogram-ready measurements for dispatch, service, serialization,
transport, and model-visible total time. The dispatcher emits the first three;
each adapter adds transport and model-visible total without recording paths,
hashes, arguments, model ids, or sample-derived content. Preserve speed with
these rules:

- query the active session and project snapshot; never create an agent-owned
  analysis session;
- return saved pseudocode before preparing a decompiler backend;
- coalesce identical calls by content hash, revision, capability, normalized
  arguments, and analysis profile;
- batch addresses and functions where natural;
- paginate before converting output into model text;
- keep structured JSON until the final language-model presentation adapter;
- stream progress for genuinely long operations, not tiny fragments; and
- discover focused tool groups on demand instead of loading a giant catalog.

Initial limits:

```text
listing rows per call       256 default / 2,048 maximum
functions per call          100 default / 1,000 maximum
xrefs per call              100 default / 2,000 maximum
strings per call            100 default / 1,000 maximum
decompiled functions        1 default / 16 batched maximum
serialized result           256 KiB default hard limit
graph nodes                 250 default / 2,000 maximum
```

Large exports become project artifacts; the tool result carries only artifact
identity, hash, schema, and row count.

---

## 5. Tool surface

Tool names and semantics are stable across the built-in registry, MCP, and
Python. Adapters may add a transport prefix but cannot change semantics.

### Context and navigation

| Tool | Purpose |
| --- | --- |
| `delver_session_info` | Project, revision, target, architecture, analysis state |
| `delver_current_context` | Current focus, function/address/ranges, visible pane |
| `delver_capabilities` | Facts, backend features, limits, schema versions |
| `delver_focus` | Navigate to an address, function, or evidence item |

`delver_focus` is a UI operation, not interpretation. It must not steal focus
unless the caller requests reveal.

### Existing static facts: first usable release

```text
delver_image_info           delver_list_functions
delver_lookup_function      delver_read_bytes
delver_disassemble
delver_decompile            delver_xrefs_to
delver_xrefs_from           delver_list_strings
delver_search_strings       delver_imports
delver_exports              delver_get_interpretation
```

`delver_decompile` returns saved-first pseudocode, variables, and exact
line/address mappings. All inventory/search tools are paginated and expose
truncation.

The first vertical slice registers `session_info`, `current_context`,
`list_functions`, `disassemble`, `decompile`, and both xref directions. That is
enough for a real function investigation before the broader catalog exists.

### Semantic depth requiring new fact services

```text
delver_basic_blocks         delver_callers          delver_callees
delver_call_graph           delver_find_paths
delver_search_bytes         delver_search_instructions
delver_list_globals         delver_global_accesses
delver_stack_frame          delver_list_types       delver_struct_info
```

Required substrate work:

- expose basic blocks and CFG edges;
- build bounded call-graph and path queries;
- add indirect-call candidates with confidence and derivation;
- add raw section/byte reads and byte/instruction search;
- model globals and data references;
- persist prototypes, stack variables, structures, unions, and enums; and
- invalidate and refresh dependent decompilation after accepted type changes.

### Authored operations

```text
delver_propose_rename       delver_propose_comment
delver_propose_tag          delver_propose_type
delver_report_finding       delver_update_work_item
```

AI writes never mutate accepted interpretation directly. Each operation records
model/client identity, confidence, rationale, and evidence. Batch requests are
atomic at the interpretation-log level and can be accepted, rejected, edited,
or reverted by a human.

Patching, arbitrary scripting, execution, network access, and sample export are
absent from the default AI tool set. Any later privileged tools require explicit
confirmation.

---

## 6. Investigation memory for large binaries

Chat history is not investigation state. `.delverdb` gains versioned records for:

```text
investigations       goals, state, model/client identity, timestamps
work_items           queued/in-progress/blocked/verified tasks
function_summaries   revision + RVA + fact fingerprint + summary + confidence
cluster_summaries    call-graph cluster/SCC summaries
findings             claims, severity, confidence, status
evidence_edges       finding/edit/summary -> tool call/range/graph path
tool_calls           normalized request, result identity, timings, omissions
```

Derived summaries are invalidated by their exact dependencies. A function
summary keys on function fingerprint, decompiler backend/version/profile,
accepted types, and interpretation sequence. A relocated unchanged function can
reuse its summary through the revision matcher; changed facts cannot.

The investigation loop is:

```text
establish project identity and capabilities
  -> triage entry points/imports/strings/reachable graph
  -> create bounded work items
  -> inspect one function or cluster
  -> record evidence-backed summary and proposals
  -> enqueue unresolved dependencies
  -> verify high-impact claims against listing/xrefs
  -> roll summaries upward
  -> stop with explicit unresolved items
```

The scheduler prioritizes reachable, exposed, high-xref, suspicious, and
analyst-selected code. It does not decompile every function by default. Context
assembly retrieves only the current work item, relevant summaries, and fresh
facts. Sample-derived content remains untrusted tool data.

---

## 7. Vendor-neutral external agent integration

`delver-mcp` is a standalone, standards-compliant MCP server. Its protocol,
tool names, schemas, authentication, and lifecycle contain no assumptions about
Claude, Kimi, Codex, Cursor, or any model vendor. Stdio is the required local
transport because it is widely supported and gives each client a private
adapter process. Streamable HTTP may be added later for controlled remote or
multi-client deployments; it must expose the same tool schemas and semantics.

Ship generic integration assets:

- a standalone `delver-mcp` executable/package;
- a client-neutral `.mcp.json` example using stdio;
- short configuration recipes for tested clients, including Kimi, Claude Code,
  Codex, Cursor, and the Delver workbench;
- optional client-specific plugins that only install/configure `delver-mcp` and
  never implement capabilities;
- a client-neutral reverse-engineering guidance document describing evidence
  and proposal policy; and
- focused tool groups (`core`, `analysis`, `types`, `proposals`) discoverable
  through MCP rather than permanently injected into every model context.

Client-specific skills or prompts are optional convenience layers. They contain
no binary-specific data, cached analysis, authorization bypass, or behavior that
is necessary for correct tool operation.

The native adapter is launched with one explicit local workspace root; it never
falls back to the current directory. A client-neutral configuration has this
shape (the packaged executable path is platform-specific):

```json
{
  "mcpServers": {
    "delver": {
      "command": "/absolute/path/to/delver-mcp",
      "args": ["--root", "/absolute/path/to/workspace"]
    }
  }
}
```

Discovery and authentication are lazy: starting the process does not prompt or
touch a target. The first `tools/list` or `tools/call` selects the matching live
Delver window and opens the one-time **Allow Once** prompt there.

The adapter reads a non-secret per-user rendezvous registry to find Delver
windows and selects the window whose canonical root fingerprint matches the MCP
root. The registry exposes an owner-only bootstrap endpoint, not a data-plane
credential. A one-shot claim must repeat the registry/window generation and
root fingerprint, then pass authorization based on OS-derived peer identity or
an explicit user grant. Client-provided names are never identity. Only then does
the bootstrap channel return a reserved private DTP endpoint plus a 256-bit,
short-lived, single-use token bound to that endpoint generation. Secrets remain
in memory and are never logged or stored in the registry. Same-user endpoint
access prevents cross-user disclosure but does not itself authorize a client.

Registry v1 is a directory of immutable `<registryEntryId>.json` publications,
not a shared manifest. Its deterministic location is
`%LOCALAPPDATA%\Delver\agent-rendezvous\v1\entries` on Windows,
`$HOME/Library/Application Support/Delver/agent-rendezvous/v1/entries` on
macOS, and `${XDG_STATE_HOME:-$HOME/.local/state}/delver/agent-rendezvous/v1/entries`
on Linux/BSD. Each strict, at-most-8-KiB entry contains only schema/bootstrap
versions, entry/window IDs, a 64-hex root fingerprint, the platform-local
bootstrap endpoint, owner PID, publication time, and the relay-owned absolute
expiry no more than 30 seconds later. Temp-file fsync and atomic no-replace
publication make windows independent; readers always re-enumerate bounded files
and ignore partial, malformed, future, expired, or wrong-platform records. PID
is diagnostic/stale-cleanup metadata only and never freshness or authority.
Windows uses a bounded one-shot mode of the staged native relay to create and
audit this directory. Every owned component must be a non-reparse directory with
the current token user as owner and a protected DACL containing exactly one
explicit OI+CI full-control ACE for that SID. Existing mismatches fail closed;
Node `chmod` is never treated as an ACL implementation. The controller accepts
one exact readiness record and clean exit with no stdout before file publication.

[`root-v1`](../architecture/root-fingerprint.md) is the normative registry matching algorithm. It accepts exactly one
explicit local `file`-scheme directory and refuses empty or multi-root
workspaces, remote and untitled workspaces, unverified URI authorities, missing
or inaccessible roots, and regular files. A Windows UNC file authority is
accepted only when it case-insensitively matches the strict ASCII server
component. Both publisher and adapter call the
native realpath operation, follow symlinks/junctions, verify that the result is
a directory, and then hash these exact bytes:

```text
SHA-256(ASCII("delver-root-v1") || 0x00 || ASCII(kind) || 0x00 || UTF8(path))
```

The output is 64 lowercase hexadecimal characters. `kind` is one of
`win32-drive`, `win32-unc`, `darwin`, `linux`, `freebsd`, or `openbsd`;
other platforms fail closed. Windows uppercases only the ASCII drive letter,
uses `/` separators, lowercases the printable-ASCII UNC server and share, and
preserves the realpath-provided case of path components. Safe extended
realpath results (`\\?\C:\...` and `\\?\UNC\server\share\...`) reduce to
their drive/UNC forms; all other device namespaces, ADS, and malformed UNC
forms are rejected. POSIX paths remain absolute, preserve case and exact UTF-8
spelling, and lose only a trailing slash outside `/`. Root-v1 performs no
Unicode normalization on any platform. NUL, unpaired UTF-16 surrogates,
noncanonical resolver output, and paths over 16 KiB in UTF-8 are rejected.

Stable root-v1 vectors are:

| Kind | Canonical path | SHA-256 |
| --- | --- | --- |
| `win32-drive` | `C:/Users/Alice/Project` | `f2ba3910dff6197279ca1c4f671d85f3b6014580b4ef125e0637e9a97fb49f6d` |
| `win32-drive` | `C:/` | `f2875af4ccc606fdeb4b57526a7bc88dbdb7d789bedc17059703c56e18cbbe38` |
| `win32-unc` | `//server/share/Project` | `62f8b7c0156774720c4178969dd4970cfcaf39b08433948a04431ec3081b9f27` |
| `linux` | `/home/alice/project` | `9994d17eec447dc153e2be8d9f4602b5031539bb1452487512e2c8f12c6d6731` |
| `darwin` | `/Users/Alice/Café` | `5202f76b7bd885e7764e201e634f504681dda90d5d797e383911ec1e42d4eb8e` |
| `darwin` | `/Users/Alice/Cafe` + U+0301 | `b5de87e0c91fe13c369397c330b5c326a756df3264aa748206eea96c388fcf56` |

The fingerprint is non-secret routing metadata, not identity or authorization.
Realpath aliases intentionally collapse; mapped-drive/UNC, mount, and hard-link
aliases need not. The bootstrap still repeats the entry/window generation and
fingerprint and still requires the explicit connection-bound grant.

One per-window lifecycle owns publication generations. It does not publish
while a bootstrap/modal is unresolved, a DTP token lease is live, teardown is
incomplete, or backoff is active. Peer idleness rotates after a small jitter;
technical/control failures use capped `1s, 2s, 5s, 15s, 30s` backoff; denial,
approval expiry/busy suppression, and credentials invalidated before
consumption use capped `30s, 2m, 5m` backoff. All delays have ±20% jitter.
Credential issuance does not reset either counter; atomic token consumption by
DTP initialization does. Root changes revoke the old lease, await durable
unpublication/relay cleanup, rotate window and entry generations, and ignore
late outcomes from the old epoch. A peer has five seconds to provide its one
bounded claim after attestation, so connecting and remaining silent cannot pin
the window indefinitely.

Multi-window ambiguity returns candidate identities and requires explicit
selection. The adapter never guesses and exposes a different window's target.

The MCP adapter implements lazy discovery, dynamic `tools/list`, `tools/call`,
cancellation, and reconnect-after-transport-failure. It exposes no arbitrary
command execution, cannot read target files directly, and cannot parse
`.delverdb` behind the IDE. DTP does not yet expose target-change or progress
events, so the adapter deliberately advertises neither `tools/list_changed` nor
operation progress. Optional read-only resources for session metadata and focus
remain a later convenience layer.

The Python client consumes the same DTP capabilities. Contract tests replay one
fixture through direct tools, MCP, and Python and require equivalent normalized
results.

---

## 8. Delivery slices

### P3a: contract and direct vertical slice · **in progress**

1. Add `IDelverAgentService`, envelopes, stable errors, limits, and telemetry.
2. Implement session, focus, function, listing, decompile, and xref handlers.
3. Register a `delver-analysis` set with `ILanguageModelToolsService`.
4. Ensure saved pseudocode is a zero-backend hit.
5. Add fake-service contracts and an active-session integration test.

Steps 1–5 are landed. The contract, the dispatcher with sixteen read/UI
capabilities, the direct tool set, fake-service unit coverage, and an
active-session run against a real binary all exist; a model investigated a
function through the direct tools and correctly distinguished partial results
from complete ones.

One acceptance gap remains inside P3a. Per-stage dispatcher and direct-adapter
latency measurements now exist for the §4 histograms, but saved-pseudocode and
offline-`.delverdb` behaviour is covered only by unit tests and has not been run
against a real project with a configured decompiler.

Exit: built-in chat investigates a selected function using direct structured
tools, with byte identity and provenance on every result.

### P3b: universal MCP access

1. Add the private JSON-safe command gateway. **Landed:** the two private
   commands validate bounded plain JSON, delegate to the canonical dispatcher,
   preserve structured errors as data, and expose a cancellation-aware seam.
2. Build the local authenticated DTP endpoint in the bridge extension.
3. Build the stdio MCP adapter and capability discovery. **Landed:** the native
   adapter implements strict MCP stdio/lifecycle, registry/bootstrap/DTP
   discovery, dynamic schema-bearing tools, structured results, cancellation,
   and reconnection without duplicating analysis logic.
4. Add window/root selection, cancellation, progress, and reconnection.
5. Publish a generic `.mcp.json`, client recipes, and optional thin installers.
   **Landed (assets):** `Docs/development/external-agents.md` publishes the
   client-neutral stdio recipe, the staged adapter paths, per-client
   arrangements, the lazy approval sequence, and troubleshooting. The
   **Copy External Agent (MCP) Configuration** command generates the exact
   recipe for the current window from the same eligibility gate activation
   uses, so a recipe is never offered for a window whose bridge stays inert.
   Thin per-client installers remain optional and unbuilt.
6. Measure direct versus MCP overhead against the budgets.

Step 2 is now production-active for eligible local windows. The built-in bridge
contains bounded DTP framing and an authenticated connection state machine; the
shared Rust reader rejects oversized headers and payloads before allocation. A
staged one-connection Rust relay exposes the current-user pipe/socket listener as
a byte-transparent stdio boundary, retains the first Windows pipe instance,
rejects remote clients and Unix path collisions, and reports readiness only
after binding. Cancellation propagates through the two-command gateway for both
explicit requests and disconnects.

`onStartupFinished` remains inert unless the window has exactly one trusted,
local file root on a supported desktop platform. The production owner composes
strict readiness, credential-free spawn, bounded backpressure, protected
non-secret registry publication, root-v1 routing, one-shot OS-attested approval,
15-second endpoint-generation-bound token leases, and prompt-spam/backoff policy.
Every root refresh unpublishes first and closes pending or authenticated private
DTP relays before applying the new fingerprint; extension shutdown awaits
registry unlink, child exit, and endpoint cleanup. Replay, expiry, endpoint
death, disconnect, and response failure revoke unconsumed credentials.

Real-process coverage claims the bootstrap, grants once, provisions a private
relay, initializes DTP, reaches gateway capabilities/invoke, cancels on
disconnect, and observes both children exit. A real workbench launch additionally
verified Restricted Mode refusal, trust-triggered token-free publication, and
deactivation cleanup. The native adapter's 20 focused tests cover public MCP
version negotiation, lifecycle, concurrent requests, cancellation, bounded
shutdown, root/registry selection, schema discovery, and result mapping.
Remaining for P3b is real client and real-binary conformance,
progress/list-change events, and transport latency measurement. Client
configuration is now generated rather than hand-written.

Exit: Kimi, Claude Code, Codex, and one minimal reference MCP client pass the
same conformance suite and read focus, cached pseudocode, instructions, and
xrefs without reopening the target. Disconnecting any client does not affect
the project or worker.

### P3c: proposals, evidence, and review

1. Complete proposed/rejected interpretation state. **Landed:** a decision is
   an append carrying `resolves`, authored by the reviewer, with the proposal
   left traceable at the resolved sequence
   ([ADR 0006](../history/adr/0006-proposal-resolution-in-the-edit-log.md)).
   `propose`, `pendingProposals`, and a validation-atomic `resolveProposals` are
   on the interpretation service; the field round-trips through the JSONL log
   and is resequenced on import.
2. Add proposal and finding tools with validation-atomic batches. **Landed:**
   attributed rename/comment/tag proposal batches and evidence-backed findings
   are live through chat, DTP, and MCP. Findings retain severity, confidence,
   described image ranges, model authorship, and reporting-call provenance.
3. Persist references to prior tool-call records and richer evidence edges.
   **Landed for direct tool-call evidence:** successful project-bound dispatcher
   exchanges are retained per revision, finding ranges may cite earlier call ids,
   and Review shows those calls and opens their complete retained request/result
   in a read-only JSON editor. Graph-path edges remain.
4. Build the pending-proposals review surface. **Landed:** one Review tree shows
   interpretation proposals and findings with human Accept/Reject actions.
5. Make evidence clickable through the focus bus. **Landed for range evidence:**
   proposal locations and each described finding range publish image focus.

Exit: an agent proposes names/comments and a finding; a human verifies each
against bytes and accepts or rejects the batch.

### P3d: semantic depth

1. Expose blocks, CFG, callers/callees, graph walks, and paths.
2. Add byte/data reads and bounded searches.
3. Add globals, stack frames, persistent types, structures, and prototypes.
4. Connect accepted-type invalidation to decompilation and summaries.
5. Add confidence-bearing indirect-call recovery.

Exit: the agent refines structures/signatures and observes improved
decompilation without losing provenance.

### P3e: durable autonomous investigations

1. Add investigations, work items, summaries, findings, and tool-call records.
2. Implement bounded scheduling and hierarchical context retrieval.
3. Reuse exact matched work across revisions; review ambiguous matches.
4. Add resumable/cancellable background operations and budgets.
5. Add investigation notebooks and report export.

Exit: a large investigation resumes from its unresolved worklist without
replaying previous model context.

### P3f: evaluation and hardening

1. Add grounded corpus tasks with known roles and evidence.
2. Measure grounding, contradictions, acceptance, tool efficiency, latency, and
   injection resistance per model version.
3. Fuzz inputs, cursors, addresses, framing, and sample-derived rendering.
4. Load-test huge inventories and concurrent agents.
5. Gate releases on compatibility and grounding regressions.

Exit: usefulness and safety are measured on repeatable investigations rather
than judged from a demonstration.

---

## 9. Validation matrix

| Layer | Required validation |
| --- | --- |
| Dispatcher | schemas, limits, cancellation, errors, revision isolation |
| Direct tools | registration, enablement, token budgets, untrusted rendering |
| Command gateway | JSON safety, no UI prompts, no accidental command exposure |
| DTP endpoint | framing, OS-user restriction, authentication, reconnect, fuzzing |
| MCP adapter | discovery, pagination, cancellation, progress, window routing |
| Persistence | atomic batches, evidence integrity, invalidation, migrations |
| Performance | warm/cold p50/p95, size, cache hits, backend phase timings |
| AI behavior | grounding, contradictions, acceptance, injection resistance |

Real-binary smoke cases include an attached warm target with cold decompiler, an
offline project with saved pseudocode, two revisions, two Delver windows, a
decompiler failure, prompt-like malicious strings, and a binary whose inventory
cannot fit in one model context.

---

## 10. Definition of done

The integration is complete when:

- built-in agents use the direct dispatcher without MCP;
- Kimi, Claude Code, Codex, and a minimal reference MCP client pass the same
  conformance suite without client-specific tool behavior;
- connecting an agent starts no target analysis or decompiler;
- warm external reads meet the measured adapter budget;
- an offline project answers saved facts and pseudocode without the sample;
- retained AI interpretation is proposed, attributed, reversible, and evidenced;
- large investigations resume from persisted work rather than chat history;
- tool results expose omissions and stale/partial state;
- hostile sample text remains untrusted data; and
- the corpus tracks grounding and injection resistance per model/backend.

The first implementation target is P3a, followed immediately by P3b. Semantic
depth and autonomous scheduling build on a usable agent connection instead of
blocking it.
