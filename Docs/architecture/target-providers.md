# Target Providers

The modular attach layer. A "target" is anything Delver can read state from: a
file on disk, a live process, a crash dump, an emulator, and — later — a
hypervisor. They differ only in which capabilities they advertise.

**PARKED:** the hypervisor provider. It is a capability superset of everything
here and is deliberately not the design driver. See B3 in
[01-Critique-and-Direction.md](../history/critique-and-direction.md).

---

## 1. Capability negotiation

```ts
// src/vs/platform/delver/common/target.ts

export const enum TargetCapability {
	ReadMemory = 'read',
	WriteMemory = 'write',
	ReadPhysical = 'physical',
	Processes = 'processes',
	Threads = 'threads',
	Registers = 'registers',
	Modules = 'modules',
	Handles = 'handles',
	KernelObjects = 'kernelObjects',
	Halt = 'halt',                       // can stop execution
	Step = 'step',
	SoftBreakpoints = 'bp.soft',
	HardBreakpoints = 'bp.hard',
	MemoryWatchpoints = 'bp.mem',        // guard pages / EPT
	Snapshot = 'snapshot',
	TimeTravel = 'timeTravel',
	EventStream = 'events',
	Symbols = 'symbols'
}

export interface ITargetDescriptor {
	readonly id: TargetId;
	readonly kind: string;               // 'file' | 'process' | 'dump' | ...
	readonly label: string;
	readonly capabilities: ReadonlySet<TargetCapability>;
	readonly spaces: readonly IAddressSpace[];
}
```

The whole UI is written against capabilities. A view whose required capability is
absent is hidden, not broken — bind context keys
(`delver.target.hasThreads`, `delver.target.canWrite`, …) and use `when` clauses
in the existing menu/view registries, exactly as VS Code does for
`debugState == 'stopped'`.

**Rule:** no code anywhere may branch on `target.kind`. If you need to know the
kind to decide behavior, the missing thing is a capability.

## 2. The provider interface

```ts
export interface ITargetProvider {
	readonly descriptor: ITargetDescriptor;
	readonly onDidChangeState: Event<ITargetStateEvent>;   // bumps the Moment
	readonly onDidEmitEvent: Event<ITargetEvent>;          // needs EventStream

	readMemory(space: SpaceId, addr: bigint, length: number, moment: IMoment,
		token: CancellationToken): Promise<IMemoryReadResult>;
	writeMemory?(space: SpaceId, addr: bigint, data: VSBuffer, moment: IMoment): Promise<void>;
	translate?(from: ILocation, to: AddressSpaceKind, moment: IMoment): Promise<ILocation | undefined>;

	listProcesses?(moment: IMoment): Promise<readonly IProcessInfo[]>;
	listThreads?(process: ProcessId, moment: IMoment): Promise<readonly IThreadInfo[]>;
	readRegisters?(thread: ThreadId, moment: IMoment): Promise<IRegisterSet>;
	listModules?(process: ProcessId, moment: IMoment): Promise<readonly IModuleInfo[]>;
	listRegions?(process: ProcessId, moment: IMoment): Promise<readonly IMemoryRegion[]>;

	halt?(): Promise<IMoment>;           // returns the frozen moment
	resume?(): Promise<void>;
	snapshot?(): Promise<string>;
}
```

`readMemory` returns a result, not a buffer, because partial reads are the normal
case — a 4 KB read spanning a paged-out page must return the valid bytes plus a
map of unreadable ranges. Views render unreadable bytes as `??`, and the AI must
be told which bytes it did *not* get. Silently zero-filling unreadable memory is
how you get a model confidently analyzing a page of nulls.

```ts
export interface IMemoryReadResult {
	readonly data: VSBuffer;
	readonly valid: readonly { offset: number; length: number }[];
	readonly moment: IMoment;            // the moment actually served
}
```

Note the returned `moment`: on a live target the provider may have served a
slightly newer epoch than requested, and the caller needs to know.

## 3. Out-of-process by default

Providers do not run in the renderer, and mostly not in Node either. The
memory-reading and binary-parsing code is the code most likely to crash and the
code most exposed to hostile input.

Transport: **JSON-RPC over stdio or a named pipe**, following the shape VS Code
already uses for LSP and DAP. Bulk memory payloads go as length-prefixed binary
frames rather than base64 in JSON — base64 for a 16 MB region read is a
measurable waste.

### Framing

Settled in [ADR 0001](../history/adr/0001-wire-protocol-framing-and-encoding.md).

LSP-style headers for JSON messages:

```
Content-Length: <n>\r\n
\r\n
<n bytes of UTF-8 JSON>
```

Binary payloads travel as separate frames:

```
Delver-Frame: <id>\r\n
Content-Length: <n>\r\n
\r\n
<n bytes raw>
```

A message references a frame inline — `{"data": {"$frame": 17, "len": 4096}}` —
and **the frame immediately follows the referencing message, before the next
JSON message.** That ordering rule keeps the reader a simple state machine.

### Numbers on the wire

**Every `u64` — addresses, lengths, offsets — is a `"0x..."` string, never a
JSON number.** JSON numbers are IEEE 754 doubles and silently truncate above
2⁵³, which is well inside kernel address range. Serde emits `u64` as a JSON
number by default, so this is the failure you get from doing nothing: use
`#[serde(with = "hex_u64")]`.

### Errors

JSON-RPC error objects; standard codes for protocol failures, a Delver range for
domain failures carrying `data: { kind, detail }`. Kinds:
`ProtocolVersionMismatch`, `NotAttached`, `InvalidAddress`, `UnreadableMemory`,
`UnsupportedCapability`, `TargetBusy`.

A **partial** read is a success carrying valid-range information — see §2.
`UnreadableMemory` is raised only when nothing was readable.

### Type separation

`delver-protocol` holds wire types (serde, hex, versioned); `delver-core` holds
domain types (`u64`, no serde derives), with conversions between them. Rationale
in [ADR 0002](../history/adr/0002-wire-types-separate-from-domain-types.md).

### Why a process boundary buys so much



- Backends in any language. The live-process provider is naturally C++/Rust; a
  dump parser might be Python; the eventual hypervisor bridge is definitely
  native.
- Crash isolation. A malformed PE that kills the parser costs you a provider
  restart, not the workspace.
- **Remote targets for free.** The analyst's IDE runs on the host; the provider
  runs inside the isolated analysis VM. The sample never touches the machine
  running the IDE. This is a genuine differentiator and it comes purely from
  choosing a process boundary here.
- Sandboxing. The provider process runs with a restricted token / AppContainer.
  See [06-Security-Model.md](security-model.md).

Managing the process: `IUtilityProcess`
(`src/vs/platform/utilityProcess/electron-main/utilityProcess.ts`) for
Delver-shipped native providers, and a spawn-and-connect path for user-supplied
ones, mirroring how debug adapters are launched.

## 4. Provider roadmap

Ordered by what they teach you, not by how impressive they are.

| # | Provider | Capabilities | Why this one |
| --- | --- | --- | --- |
| # | Provider | Phase | Capabilities | Why this one |
| --- | --- | --- | --- | --- |
| 1 | **File** (PE on disk; ELF/Mach-O later) | P0–P1 | Read, Modules, Symbols | Proves the workspace is useful with the weakest possible backend. Zero risk, fast iteration. |
| 2 | **Crash dump / minidump** | P2 | Read, Processes, Threads, Registers, Modules, KernelObjects (full dumps) | The cheap second capability set: a file parser, no debug loop. Immutable, so trivially coherent — a good test bed for Moment handling. |
| 3 | **Live local process** | P4 | Read, Write, Processes, Threads, Registers, Modules, Handles, Halt, Step, Breakpoints | First *live* target. Unlocks the memory-vs-disk diff and the unpacking timeline. |
| 4 | **Emulator** (Unicorn / QEMU) | P6 | everything + Snapshot + Step | Safe execution of hostile code. Excellent for shellcode and unpacking loops. |
| 5 | **Kernel debugger** (KD / EXDI) | P7 | Read, ReadPhysical, KernelObjects, Halt, Breakpoints | Validates the physical/virtual translation model before any hypervisor work. |
| 6 | **Hypervisor** — **PARKED** | P7 | all of the above + MemoryWatchpoints via EPT, TimeTravel, stealth | Capability superset. Drops in when the abstraction has survived several other backends. |

**Getting to a second provider early is the most important sequencing decision in
this document** — a one-implementation abstraction is always wrong. With the
debugger deferred behind decompilation and AI, the minidump provider is what
keeps that honest at a fraction of the cost.

## 5. The workbench-side service

```ts
// src/vs/workbench/services/delver/common/targetService.ts

export interface IDelverTargetService {
	readonly _serviceBrand: undefined;
	readonly targets: readonly ITargetDescriptor[];
	readonly activeTarget: ITargetDescriptor | undefined;
	readonly onDidChangeTargets: Event<void>;
	readonly onDidChangeActiveTarget: Event<void>;

	registerProviderFactory(kind: string, factory: ITargetProviderFactory): IDisposable;
	attach(kind: string, config: unknown): Promise<TargetId>;
	detach(id: TargetId): Promise<void>;
}
```

Attach configuration should reuse the launch-configuration pattern: a
`delver.json` in `.vscode/`-style workspace config, with completion and
validation from a JSON schema, and a picker for ad-hoc attach. Analysts already
understand this model from `launch.json`, and it makes attach setups shareable
and reviewable.

## 6. On reusing DAP

Tempting shortcut for provider #2: implement a debug adapter and get VS Code's
call stack, breakpoints, watch, variables, and disassembly views with no fork
changes at all.

Worth doing as a **staged tactic**, with eyes open:

- **Pro:** several complete, polished views for the cost of an adapter. Very
  fast path to a demoable live-debug experience in P4. See [09-Debugger-PoC.md](debugger-provider.md) D3.
- **Con:** DAP is source-line-centric. It has no concept of address spaces,
  physical memory, kernel objects, or Moments. It will fight every kernel and
  hypervisor feature you eventually want.

**Recommendation:** ship a DAP adapter for the live-process provider as a
convenience layer, but do not let DAP's model leak into
`ITargetProvider`. The native provider interface stays the source of truth; the
adapter is a translator on top of it that can be dropped later without touching
anything below.
