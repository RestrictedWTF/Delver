# Data Model

The data model is the part that is expensive to change later. Everything else in
Delver can be rewritten in a week; this can't. Get it right before writing views.

Proposed home: `src/vs/platform/delver/common/`.

---

## 1. Location — where

There is no such thing as "an address" on its own. A number is meaningless
without knowing which address space it lives in.

```ts
// src/vs/platform/delver/common/address.ts

export type SpaceId = number & { readonly _brand: 'SpaceId' };

export const enum AddressSpaceKind {
	/** Guest/process virtual memory, qualified by a page-table root. */
	Virtual,
	/** Machine physical memory. */
	Physical,
	/** Bytes as they appear in a file on disk (raw file offsets). */
	File,
	/** File bytes projected as if loaded (RVA space, sections applied). */
	Image,
	/** Not backed by memory: decompiler output, synthesized listings. */
	Synthetic
}

export interface IAddressSpace {
	readonly id: SpaceId;
	readonly kind: AddressSpaceKind;
	/** Human label, e.g. "notepad.exe (pid 4132)" or "ntoskrnl.exe @ file". */
	readonly label: string;
	readonly pointerBits: 32 | 64;
	/** Page-table root for Virtual spaces; identifies the process. */
	readonly pageTableRoot?: bigint;
	/** Space this one translates into, e.g. Virtual -> Physical. */
	readonly translatesTo?: SpaceId;
}

export interface ILocation {
	readonly space: SpaceId;
	readonly addr: bigint;
}

export interface IAddressRange {
	readonly space: SpaceId;
	readonly start: bigint;
	readonly length: bigint;
}
```

Use `bigint`, not `number`. A 64-bit kernel address exceeds `Number.MAX_SAFE_INTEGER`,
and every tool that has used doubles for addresses has eventually shipped a
silent truncation bug. Pay the ergonomic cost now.

`translatesTo` is what makes "show me the physical page behind this virtual
address" a model operation rather than a special case, and it's how the same
`ILocation` type serves a file provider and a hypervisor provider.

## 2. Moment — when

```ts
// src/vs/platform/delver/common/moment.ts

export const enum MomentKind {
	/** Follows the target. Reads may observe change between calls. */
	Live,
	/** Target is halted; reads within this epoch are coherent. */
	Frozen,
	/** A captured, immutable state. */
	Snapshot,
	/** A position within a recorded execution trace. */
	Replay
}

export interface IMoment {
	readonly kind: MomentKind;
	/** Monotonic per target. Bumped whenever observable state may have changed. */
	readonly epoch: number;
	readonly snapshotId?: string;
	/** Trace position for MomentKind.Replay. */
	readonly tick?: bigint;
}
```

Rules:

- Every read API takes an `IMoment`. No exceptions, including the file provider
  (where it's a constant).
- Every cache key includes the moment's identity.
- A view showing data from a stale epoch must say so visibly rather than
  silently displaying it. A greyed-out "stale — target advanced" strip is the
  minimum.
- `Live` reads are best-effort and must be labelled as such in AI context. A
  model reasoning over torn reads will produce confident nonsense.

## 3. Facts vs. interpretation

Two stores with different rules. This split is the reason the AI can be audited.

### Facts — derived, recomputable, discardable

Bytes, decoded instructions, basic block boundaries, xrefs, PE structures,
detected function starts, string locations. Same input bytes → same facts, for
everyone, forever. Keyed by content hash of the input, so the cache is shareable
and can be thrown away without losing user work.

Storage: typed columnar tables. Concretely, per analyzed image:

```
instructions(addr INTEGER PRIMARY KEY, len INT, mnemonic_id INT, flags INT, ...)
blocks(id INTEGER PRIMARY KEY, start INT, end INT, func_id INT)
functions(id INTEGER PRIMARY KEY, entry INT, flags INT)
xrefs(from_addr INT, to_addr INT, kind INT)          -- indexed both directions
strings(addr INT, len INT, encoding INT)
sections/imports/exports/relocs/...
```

Do not build a `Instruction` object per row. The listing view asks for a range
and gets back a packed buffer it decodes into row templates on demand.

### Interpretation — authored, attributed, append-only

Names, types, signatures, comments, tags, hypotheses, findings, "this region is
the unpacked stage 2".

```ts
// src/vs/platform/delver/common/interpretation.ts

export interface IAuthor {
	readonly kind: 'human' | 'rule' | 'model' | 'import';
	/** Analyst name, rule ID, model ID, or source tool. */
	readonly id: string;
}

export interface IEdit {
	readonly seq: number;
	readonly at: number;                 // wall clock
	readonly author: IAuthor;
	readonly anchor: Anchor;
	readonly op: EditOp;                 // rename | setType | comment | tag | ...
	readonly value: unknown;
	/** Evidence supporting this edit — tool calls, findings, other edits. */
	readonly evidence?: readonly EvidenceRef[];
	/** Unpromoted edits are visible-but-provisional. See 05-AI-Analyst.md. */
	readonly status: 'proposed' | 'accepted' | 'rejected';
	/** Earlier accepted edits whose effects this append compensates. */
	readonly compensates?: readonly number[];
	/** Earlier proposals this append decides. ADR 0006. */
	readonly resolves?: readonly number[];
}
```

Because it's an append-only log:

- Undo is trivial and unbounded.
- "Show only AI changes" is a filter.
- "Revert everything the model did on Tuesday" is a filter plus a compensating
  append.
- Two analysts' work merges as two logs, with conflicts detected per anchor.
- Review UI (accept/reject) is a filter over `status === 'proposed'` minus the
  proposals a later append `resolves`. A decision is itself an append: accepting
  copies the proposal's anchor/op/value under the *reviewer's* authorship,
  rejecting records what was declined and touches nothing
  ([ADR 0006](../history/adr/0006-proposal-resolution-in-the-edit-log.md)).

Materialize a current-state view over the log for fast reads; the log is the
truth, the materialized table is a cache.

## 4. Anchors — surviving relocation

Absolute virtual addresses are not identities. ASLR, re-dumping, a different
process loading the same DLL, or a snapshot taken at a different time will all
move them.

```ts
export type Anchor =
	/** Preferred: stable across ASLR, re-dumps, and other processes. */
	| { kind: 'image'; contentHash: string; rva: number }
	/** Symbol-relative; survives version bumps better than RVA. */
	| { kind: 'symbol'; module: string; name: string; offset: number }
	/** Dynamically allocated / injected code with no file backing. */
	| { kind: 'alloc'; allocKey: string; offset: number; fingerprint: string }
	/** Last resort. Explicitly scoped to one moment. */
	| { kind: 'absolute'; space: SpaceId; addr: bigint; moment: IMoment };
```

`contentHash` for an in-memory image should be computed over the *file* bytes
where available, or over a normalized form of the memory image (relocations
undone, IAT zeroed, writable data sections excluded) so a loaded module still
matches its on-disk counterpart. That normalization function is also what powers
the memory-vs-disk diff in [01-Critique-and-Direction.md](../history/critique-and-direction.md) G1 — build it once.

When re-attaching anchors to a new target, report each as `exact` (a unique,
versioned normalized function fingerprint matched), `fuzzy` (structural evidence
matched at a disclosed lower confidence), or `orphaned`. Duplicate exact
fingerprints are ambiguous rather than matched by address or order. Never
silently attach a name to the wrong bytes; that is how an analyst reaches a
wrong conclusion with full confidence. See
[session-persistence.md](session-persistence.md#function-identity-across-revisions).

## 5. The graph layer

The graph is an API, not a storage engine.

```ts
export interface IGraphQuery {
	from(node: NodeRef | readonly NodeRef[]): IGraphQuery;
	out(edge: EdgeKind, opts?: { depth?: number }): IGraphQuery;
	in(edge: EdgeKind, opts?: { depth?: number }): IGraphQuery;
	where(pred: (n: NodeRef) => boolean): IGraphQuery;
	nodes(): AsyncIterable<NodeRef>;
}
```

Node kinds worth materializing: `Module`, `Function`, `BasicBlock`, `Process`,
`Thread`, `MemoryRegion`, `Handle`, `KernelObject`, `Import`, `Export`, `Token`,
`RegistryKey`, `Socket`, `Event`, `Snapshot`, `Finding`, `Recipe`.

Node kinds that must stay virtual (computed on demand from columnar stores):
`Instruction`, `Byte`, individual `Xref`.

Edge kinds: `calls`, `references`, `reads`, `writes`, `executes`, `owns`,
`allocates`, `maps`, `creates`, `inherits`, `hooks`, `derivedFrom`,
`evidenceFor`.

`derivedFrom` and `evidenceFor` are the provenance edges — they're what let the
UI answer "why does the workspace believe this?" and they should be present from
the first commit.

## 6. Findings and recipes

```ts
export interface IFinding {
	readonly id: string;
	readonly title: string;
	readonly severity: 'info' | 'suspicious' | 'malicious';
	readonly anchors: readonly Anchor[];
	readonly author: IAuthor;
	readonly confidence: number;          // 0..1, and always shown
	readonly evidence: readonly EvidenceRef[];
	readonly recipeId?: string;           // the rule that produced it, if any
}
```

Findings map directly onto VS Code's `IMarkerService`, which gives free
navigation, a Problems-panel-shaped list, filtering, and gutter decorations. See
[04-IDE-Architecture.md](ide-architecture.md).

A `Recipe` is a concluded investigation compiled into something re-runnable: a
byte/YARA pattern, a structural graph query, or a behavioral event sequence, plus
the findings that justified it. Capture the schema in P1 even if nothing consumes
it until P6.

## 7. Persistence — the `.delverdb` project

One SQLite database per saved project (WAL mode while open), holding:

| Table group | Rewritable? | Notes |
| --- | --- | --- |
| `target_*` | yes | Content hash, format metadata, and optional source locator; never sample bytes |
| `fact_*` | yes | Derived analysis, keyed by content hash and schema version. Deletable. |
| `decompile_*` | yes | Text, mappings, variables, and provenance qualified by backend/version/profile |
| `edit_log` | **no** | Append-only interpretation. The user's actual work. |
| `finding`, `recipe` | no | Investigation output |
| `session_*` | yes | Layout, open editors, focus history |

Design constraints worth honoring:

- Opening a raw binary creates an untitled in-memory session. Once analysis
  produces durable content, close, target replacement, and application shutdown
  prompt Save / Don't Save / Cancel. A named project autosaves each durable
  change incrementally.
- The project must open with **no target attached** — reviewing yesterday's
  analysis on a laptop is the common case.
- The project must be shareable as a single file, and must be openable by
  someone who does not have the sample.
- Never store captured sample bytes in `.delverdb`; a sample is attached
  separately and only after its content hash matches the project. See
  [security-model.md](security-model.md).
- Checkpoint WAL before Save As, clean close, export, or sharing so the portable
  artifact is one complete `.delverdb` file.
- Derived cache identity includes content hash, backend identifier, backend
  version, analysis profile, and schema version. Interpretation remains anchored
  to the content hash and is not invalidated by switching decompilers.
- Ghidra projects and future native IDA databases are disposable local
  accelerators under user data, not portable project state or records of truth.

The exact lifecycle, dirty-state boundary, and backend-cache separation are in
[session-persistence.md](session-persistence.md) and ADR
[0005](../history/adr/0005-portable-project-database.md).

## 8. Performance budget

State it now so views are designed against it:

- Listing scroll must stay at 60 fps, so the row data source answers
  **synchronously** from an in-memory window; anything not cached renders a
  placeholder row and fills in asynchronously.
- Cache ~4,000 rows around the viewport, prefetch two screens in the scroll
  direction.
- Never decode a whole module to display a screen. Linear-sweep decode of a
  window plus known function starts.
- Any operation that can exceed 100 ms is async, cancellable, and reports
  progress through `IProgressService`.
