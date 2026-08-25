# IDE Architecture

How Delver sits inside the VS Code fork: where code lives, what to reuse, and how
each view is built.

The governing rule: **write new files, touch as few upstream files as possible,
and log every one you do touch in [PATCH-SURFACE.md](../development/patch-surface.md).** Upstream
moves fast. New folders almost never conflict; edits to
`workbench.common.main.ts` always do. (Scripting deliberately avoids the
`extHost.*` files entirely — see §5.)

---

## 1. Where code lives

> Summary only — [08-Project-Structure.md](project-structure.md) is the
> authoritative layout, and covers the native `delver/` Rust workspace, naming
> conventions, and build wiring.

Follow the existing layering (`base` → `platform` → `editor` → `workbench`); the
`code-layering` and `code-import-patterns` lint rules will enforce it.

```
src/vs/platform/delver/common/          address.ts, moment.ts, target.ts,
                                        interpretation.ts, findings.ts
src/vs/platform/delver/node/            provider process management
src/vs/workbench/services/delver/       targetService, focusService,
                                        analysisService, interpretationService
src/vs/workbench/contrib/delverListing/ disassembly / listing editor
src/vs/workbench/contrib/delverMemory/  hex + memory map + region lifecycle
src/vs/workbench/contrib/delverRuntime/ processes, threads, handles, objects
src/vs/workbench/contrib/delverGraph/   CFG, call graph, object graph
src/vs/workbench/contrib/delverFindings/findings + recipes
src/vs/workbench/contrib/delverAI/      AI tool registration, proposal review
```

Each `contrib` gets a `<name>.contribution.ts` registered by a single added
import line in `src/vs/workbench/workbench.common.main.ts`. That's one line per
feature of merge exposure — acceptable.

### Why `contrib/` and not a new `src/vs/delver/` layer

`src/vs/sessions/` exists as a sibling layer to `workbench`, so there's precedent
for a whole new layer. Don't take it. That layer exists because agent sessions
are a *separate window* with a different shell. Delver's views live *inside* the
normal workbench alongside editors and terminals, so they're contributions.
Revisit only if Delver later grows a dedicated standalone window.

> **Still true — but the container beneath it changed.**
> [ADR 0007](../history/adr/0007-workspace-editor-over-sidebar-container.md)
> moves Delver's surfaces out of the sidebar view container and into a
> **workspace editor** with three fixed-role zones. That is still a
> contribution inside the normal workbench, so the paragraph above stands; what
> it supersedes is the assumption that each surface is a `ViewPane` in
> `workbench.view.delver`. Surfaces are now plain widgets registered through
> `services/delver/browser/delverSurfaceRegistry.ts`, hosted either by a zone or
> by a thin `EditorPane` for tear-off. See
> [`design/workspace.md`](../design/workspace.md) before adding a surface.

## 2. What to reuse — the fork dividend

This is the actual reason to fork VS Code rather than start from a blank Electron
app. Each row is work you don't do.

| VS Code subsystem | Delver use |
| --- | --- |
| Editor groups, tabs, splits, layout persistence | Listings, hex, pseudocode, graphs as real editors — split a listing against its decompilation, save the layout |
| `EditorInput` + editor history | Editor tabs, splits, and layout persistence — used by the workspace editor and by torn-off surfaces. **Not** the source of address history: see the note below |
| Quick access (`Ctrl+P`, `IQuickInputService`) | "Go to address / symbol / function / string" with prefixes. Enormous value, near-zero cost |
| `IMarkerService` + Problems panel | Findings, YARA hits, suspicious API usage — with navigation and gutter decorations included |
| Search viewlet patterns | Byte pattern / regex / YARA search with a results tree |
| Diff editor + SCM UI | Memory-vs-disk, snapshot-vs-snapshot diff |
| Peek widget | Peek the callee's disassembly inline without leaving the caller |
| Outline view | Function list for the active listing |
| Notebooks (`contrib/notebook`) | **Investigation notebooks** — the AI workspace surface. See [05-AI-Analyst.md](ai-analyst.md) |
| Timeline view | Memory region lifecycle, execution events |
| Comments contrib | Annotations anchored to addresses; review threads on AI proposals |
| Chat + `ILanguageModelToolsService` (`contrib/chat/common/tools/`) | The AI analyst and its structured tools |
| MCP (`contrib/mcp`) | External analysis tools — a Ghidra or IDA bridge — as tool providers |
| Integrated terminal + notebook kernels | Host the Python scripting client, with no fork surface (§5) |
| Settings, profiles, keybindings, themes | Free, and analysts expect all of it |
| `IProgressService`, `CancellationToken` | Long analysis operations behave correctly |
| `IUtilityProcess` | Hosting provider and analysis processes |

> **Correction: address history is the focus bus's, not the editor's.** This
> table originally credited `EditorInput` history with giving address
> back/forward "for free", and that claim was load-bearing in the argument for
> making the listing an editor. It is no longer accurate —
> `IDelverFocusService` owns a real history stack with proximity coalescing and
> a `FOCUS_HISTORY_ORIGIN` (§3), so back/forward works regardless of what hosts
> the listing. This is why
> [ADR 0007](../history/adr/0007-workspace-editor-over-sidebar-container.md)
> could move the listing into a workspace zone at no navigational cost. Editor
> tabs, splits and layout persistence remain genuine dividends and are still
> used — for the workspace editor itself and for torn-off surfaces.

## 3. The focus bus — how synchronization actually works

The vision's "everything is synchronized" needs one owner of truth and an
explicit anti-feedback mechanism, or views will ping-pong updates forever.

```ts
// src/vs/workbench/services/delver/common/focusService.ts

export interface IFocus {
	readonly target?: TargetId;
	readonly moment: IMoment;
	readonly location?: ILocation;
	readonly selection?: IAddressRange;
	readonly process?: ProcessId;
	readonly thread?: ThreadId;
	readonly frame?: number;
}

export interface IFocusChangeEvent {
	readonly focus: IFocus;
	readonly previous: IFocus;
	/** Identity of the view that caused this. Views ignore their own echoes. */
	readonly origin: string;
	readonly reason: 'user' | 'navigation' | 'targetEvent' | 'ai' | 'script';
}

export interface IDelverFocusService {
	readonly _serviceBrand: undefined;
	readonly focus: IFocus;
	readonly onDidChangeFocus: Event<IFocusChangeEvent>;
	setFocus(partial: Partial<IFocus>, origin: string, reason: FocusReason): void;
	back(): void;
	forward(): void;
}
```

Requirements that fall out of experience with tools that got this wrong:

- **`origin` on every change.** A view that receives its own origin back does
  nothing. Without this you get infinite update loops the first time two views
  can both scroll.
- **Per-view pin/unpin.** An analyst comparing two functions must be able to
  freeze one listing while navigating in another. Make it a title-bar toggle on
  every synchronized view, from the first one you build.
- **History is a stack of `IFocus`, deduplicated by proximity** — scrolling
  three instructions should not create three history entries. Coalesce within a
  basic block, and within a time window. Listings expose the same stack through
  Alt+Left/Alt+Right and Mouse4/Mouse5.
- Prefer direct service calls over events for *commands* (per the repo coding
  guidelines); the focus bus is legitimately a state broadcast, which is exactly
  what events are for.

## 4. View-by-view implementation notes

### Listing (disassembly) — a virtualized table, not a text editor

Do **not** put a whole module's disassembly into a Monaco text model. Monaco is a
text editor: addresses aren't lines, decorations get heavy in the hundreds of
thousands of lines, and you'd fight it forever.

The correct base already exists in the repo:
`src/vs/workbench/contrib/debug/browser/disassemblyView.ts` — an `EditorPane`
hosting a `WorkbenchTable` with `ITableRenderer`s per column. Read it before
writing anything. Delver's listing is that pattern with:

- a paged, cancellable data source over `IAnalysisService` rather than DAP
- columns: breakpoint gutter, address, bytes, mnemonic, operands, xref margin;
  an authored label is a bounded line owned by the instruction row, while its
  comment and `#tag` tokens follow the operands on the instruction line
- placeholder rows while a page is in flight (never block the scroll)
- the caveat noted in that file — `WorkbenchTable` doesn't do dynamic row
  heights — which matters if you want wrapped source/pseudocode interleaving.
  Delver's single-line labels have deterministic heights and fit the existing
  per-element delegate. Wrapped or unbounded interleaving
  still requires a custom list delegate and must be budgeted explicitly.

Build the table as a plain widget implementing `IDelverSurface`, so the
workspace's Primary zone and a tear-off `EditorPane` can both host it
([ADR 0007](../history/adr/0007-workspace-editor-over-sidebar-container.md)).
`DelverListingInput` — keyed by target + space + anchor — survives as the
tear-off target, which is what gives a torn-off listing tabs, splits, and
layout persistence.

### Pseudocode — this one *is* Monaco

Decompiler output is text, is per-function, and is small. Monaco is the right
tool and gives you syntax highlighting, folding, find, hover, and peek for free.

Register a `delver-pseudo:` URI scheme with an `ITextModelContentProvider`, and a
`delver-c` language. Maintain a **line ↔ address map** alongside the model so
clicking a pseudocode line drives the focus bus and highlights the corresponding
instructions in the listing. That bidirectional map is the feature; the text
rendering is free.

### Hex / memory — virtualized, provider-backed

Look at `src/vs/workbench/contrib/debug/browser/debugMemory.ts` for how VS Code
already models memory-as-a-file. Key requirements: render unreadable bytes as
`??` distinctly from zero bytes, and show region protection in the gutter.

### Graphs (CFG, call graph, object graph)

The trap here is rendering ten thousand nodes and calling it a feature. Nobody
reads that graph.

- Default to a **function-scoped CFG** with a proper layered layout
  (Sugiyama-style; `dagre`-equivalent). Node count in the tens to low hundreds.
- Call graphs open **neighborhood-first** — the selected function plus N hops,
  expandable — never whole-program by default.
- SVG is fine at these sizes and gives free accessibility, theming, and hit
  testing. Reach for canvas/WebGL only when a specific view genuinely needs
  thousands of nodes.
- Graph nodes drive the focus bus like everything else.

### Runtime views (processes, threads, handles, objects)

Plain `WorkbenchTree`/`WorkbenchTable` wrapped as `IDelverSurface`s and
registered into the workspace's Inspector zone
([`design/workspace.md`](../design/workspace.md)). Capability-gated with `when`
clauses on the surface descriptor. These are the cheapest views to build and
among the most used — do them early.

### Findings

Back them with `IMarkerService` and you inherit the Problems panel's navigation,
filtering, and decorations. Add a dedicated view only when findings need
structure markers can't express (evidence trees, confidence sorting) — and even
then, keep writing markers so the standard navigation keeps working.

## 5. Scripting — Python over the protocol

One capability surface, three consumers: the UI, AI tools, and user scripts.
The surface is DTP plus the AI tool set — it exists whether or not anyone
scripts against it. The only decision is which client users get.

**Decision: a Python client over DTP. No `delver.*` TypeScript extension-host
API.** Rationale in [01-Critique-and-Direction.md](../history/critique-and-direction.md)
B6; the short version is that Python is what RE analysts already write, and the
`extHost.*` files are the highest-conflict files in the fork.

This means **zero fork surface for scripting.** No `MainThreadDelver`, no
`ExtHostDelver`, no touching `extHost.api.impl.ts`.

### Mechanism

The workbench hosts a local DTP endpoint and advertises it to child processes:

- **Windows:** named pipe, per-session random name, restrictive ACL.
  **POSIX:** Unix socket in a mode-0700 directory.
- The IDE sets `DELVER_SESSION` (endpoint + auth token) in the environment of
  the integrated terminal and any notebook kernel it launches, the same way
  VS Code passes shell-integration and askpass state.
- `import delver; s = delver.session()` then just works inside the IDE, and
  requires explicit connection info outside it.

**Token-auth it properly.** That endpoint grants arbitrary memory read/write on
whatever is attached. An unauthenticated local socket here is a real
vulnerability, not a theoretical one — see
[06-Security-Model.md](security-model.md).

### Shape

```python
s = delver.session()
t = s.active_target
fn = s.functions.at(0x401000)
for x in s.xrefs_to(fn.entry):
    print(hex(x.frm), s.disassemble(x.frm, 1)[0].text)

s.rename(fn.anchor, "decrypt_config")   # authored as this script's identity
s.report_finding(title="RC4 key schedule", anchors=[fn.anchor], confidence=0.8)
s.focus(fn.entry)
```

Attribution is enforced by the endpoint, not by convention: every write records
the calling client's identity, so a script's renames are exactly as auditable as
the model's ([02-Data-Model.md](data-model.md) §3).

### UI operations over the protocol

A socket client can't contribute views or menu items. Expose a small set of UI
ops instead — `report_finding`, `focus`, `annotate`, `open_listing` — and that
covers most of what a plugin would want. Anything beyond it is a contrib.

For "run this pass on every binary I open," add a small script-runner contrib
that executes registered Python scripts on workspace events. That's a contrib,
not an API layer.

### Notebooks

This makes the investigation notebook simpler than originally planned: a Python
cell plus the Delver client, with the notebook's existing rich output. No custom
query-cell type required. See [05-AI-Analyst.md](ai-analyst.md) §4.

### If a TypeScript API is ever needed

Only when someone genuinely needs a UI-contributing plugin. It would follow the
`vscode.*` pattern (`MainThreadDelver` + `ExtHostDelver`), and it is the
**most merge-expensive change available** — batch it into one deliberate
landing, and add the rows back to
[PATCH-SURFACE.md](../development/patch-surface.md) when you do.

## 6. Analysis runs out of process

`IAnalysisService` in the workbench is a thin client. The real work — parsing,
disassembly, decompilation, xref building — runs in an **analysis server**
process, same transport as providers.

- Disassembly engine: `iced-x86` (Rust; fast and accurate for x86/x64) or
  Capstone/Zydis for breadth. Keep it behind an interface — you will want a
  second architecture eventually.
- Decompiler: out-of-process, pluggable, p-code-or-equivalent IR consumed by
  your semantic passes. See B5 in
  [01-Critique-and-Direction.md](../history/critique-and-direction.md).
- The renderer never parses sample bytes. Ever. See
  [06-Security-Model.md](security-model.md).

## 7. Branding and fork hygiene

- `product.json`: `nameShort`/`nameLong`/`applicationName`/`dataFolderName`/
  `urlProtocol`, app IDs, and mutex names. Strip Microsoft branding per MIT.
- Gallery: point at Open VSX or self-host. The Microsoft marketplace's terms do
  not permit non-VS Code clients.
- Keep an `upstream` remote and merge on a fixed cadence (monthly is
  manageable; quarterly is not). Every merge, re-verify the entries in
  [PATCH-SURFACE.md](../development/patch-surface.md).
- Telemetry: default off, and be loud about it. The user base is security
  analysts handling other people's incident data.
