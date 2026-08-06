# Debugger Proof of Concept

A deliberately basic live-process debugger, landing in **P4** — deferred behind
decompilation and AI, per [07-Roadmap.md](../planning/roadmap.md). Its job is **not** to
be a good debugger. Its job is to unlock the memory-vs-disk diff and the
unpacking timeline, and to be the provider that proves
[03-Target-Providers.md](target-providers.md) works for a *live* target.

Because it's deferred, the **minidump provider in P2** carries the
abstraction-validation load in the meantime — it's a file parser with no debug
loop, so it costs far less to reach a second capability set.

**Pull D0 forward out of P4** if the team's work turns out to be mostly packed
malware. It's M-sized, depends on nothing in P2 or P3, and the diff it enables is
what makes packers tractable.

Scope: **Windows, x64 targets, user mode.** Crate `provider-winproc`, binary
`provider-winproc`, built with the `windows` crate (official Microsoft bindings).

Staged so each stage ships something useful on its own.

---

## D0 — Non-invasive attach (read-only)

No debug loop at all. Just open the process and read it. Roughly 300 lines, and
it delivers the memory-vs-disk diff on its own.

| Need | API |
| --- | --- |
| Attach | `OpenProcess(PROCESS_QUERY_INFORMATION \| PROCESS_VM_READ, …)` |
| Enumerate processes | `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` |
| Modules | `EnumProcessModulesEx` (use `LIST_MODULES_ALL`) |
| Threads | `CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD)` |
| Memory regions | `VirtualQueryEx` walk |
| Read memory | `ReadProcessMemory` |
| Registers | `SuspendThread` → `GetThreadContext` → `ResumeThread` |

Capabilities advertised: `Read`, `Processes`, `Threads`, `Modules`, `Registers`.
Notably **not** `Halt` — the process runs freely, so every read is
`MomentKind.Live` and views must show staleness.

**What D0 already unlocks:** the memory-vs-disk image diff. Read a loaded
module, normalize it (undo relocations, zero the IAT — the same normalization
that powers anchor matching in [02-Data-Model.md](data-model.md) §4), and diff
against the file. That finds inline hooks, IAT patches, and unpacked sections
without a single breakpoint.

Ship D0 on its own. Don't wait for D1.

---

## D1 — Invasive debug loop

Now the process can actually be stopped.

```
DebugSetProcessKillOnExit(FALSE)   // detaching must not kill the target
DebugActiveProcess(pid)
loop {
    WaitForDebugEvent(&ev, timeout)
    …dispatch…
    ContinueDebugEvent(pid, tid, status)
}
DebugActiveProcessStop(pid)        // detach
```

### The one thing everybody gets wrong

**The Win32 debug loop is thread-affine.** `WaitForDebugEvent` and
`ContinueDebugEvent` must be called from the same thread that called
`DebugActiveProcess`. Get this wrong and you get intermittent
`ERROR_INVALID_HANDLE` that reproduces once a week.

Structure in Rust: one dedicated OS thread owns the target for its entire
lifetime. Everything else — the RPC server, other requests — communicates with it
over channels. The debug thread is a state machine; it never blocks on anything
except `WaitForDebugEvent`.

```
RPC thread  ──command channel──▶  debug thread (owns the target)
RPC thread  ◀──event channel───   debug thread
```

Requests that arrive while running are queued and serviced at the next stop, or
rejected with a clear "target is running" error. Don't try to service them
concurrently.

### Events to handle

| Event | Action |
| --- | --- |
| `CREATE_PROCESS_DEBUG_EVENT` | Record image base, main thread. **Close `ev.u.CreateProcessInfo.hFile`** or you leak a handle per attach |
| `CREATE_THREAD` / `EXIT_THREAD` | Update the thread list; arm hardware breakpoints on new threads (D2) |
| `LOAD_DLL` / `UNLOAD_DLL` | Update the module list. Also close `hFile` |
| `EXCEPTION_DEBUG_EVENT` | The main dispatch — see D2 |
| `OUTPUT_DEBUG_STRING_EVENT` | Surface it; it's often high-signal in malware |
| `EXIT_PROCESS` | Transition to detached, tell the workbench |

### Moment integration

This is where `IMoment` earns its place:

- Every debug event bumps the epoch.
- Stopped at an event → `MomentKind::Frozen`. Reads within that epoch are
  coherent and can be cached aggressively.
- Running → `MomentKind::Live`. Reads are best-effort, cached for milliseconds
  at most, labelled stale in the UI and in AI tool results.

Capabilities added: `Write`, `Halt`, `EventStream`.

`Halt` is either "wait for the next natural event" or `DebugBreakProcess` to
force one. Offer both; they behave very differently on a sample that's idle in a
sleep loop.

---

## D2 — Breakpoints and stepping

### Software breakpoints

```
set:   save original byte at addr; write 0xCC (VirtualProtectEx if needed)
hit:   EXCEPTION_BREAKPOINT at addr+1
       → restore original byte
       → RIP -= 1  (GetThreadContext / SetThreadContext)
       → report the stop
resume: set EFLAGS.TF, single-step off the instruction,
        re-write 0xCC on EXCEPTION_SINGLE_STEP, clear TF, continue
```

That re-arm dance is the fiddly part and the reason to write it once, carefully,
with tests.

### Gotchas worth writing down now

- **The first `EXCEPTION_BREAKPOINT` after attach is the system's**, injected by
  the loader. Swallow it; don't report it as a user breakpoint.
- **Always `FlushInstructionCache`** after patching bytes.
- `first_chance` vs `second_chance` on `EXCEPTION_DEBUG_EVENT`: report
  first-chance exceptions but continue with `DBG_EXCEPTION_NOT_HANDLED` unless
  the breakpoint is yours, or you'll swallow the target's own exception handling
  and change its behavior.
- **Self-modifying and self-checking code** will notice your `0xCC`. That's
  expected; it's also a finding worth reporting.
- Hardware breakpoints (DR0–DR3 + DR7) are **per-thread**. They must be set on
  every existing thread *and* on every new thread as it's created. Defer to P6,
  but know why.
- Single-step via `EFLAGS.TF` produces `EXCEPTION_SINGLE_STEP`; distinguish
  yours from the target's.
- **WOW64 / 32-bit targets** need `Wow64GetThreadContext` and a different
  register set. Decide explicitly: PoC is x64-only, and the provider should
  refuse a 32-bit target with a clear message rather than misbehaving.

### Call stack

Frame-pointer walk (`RBP` chain) is enough for the PoC and works on most
non-optimized code. Proper x64 unwinding needs the exception directory
(`RUNTIME_FUNCTION` / `UNWIND_INFO`) — the PE loader from P1 already parses that
directory, so real unwinding is a P6 upgrade, not a rewrite.

Capabilities added: `SoftBreakpoints`, `Step`.

---

## D3 — Surfacing it in the IDE

Two options, and the recommendation is to do the second.

**Option A — DAP shim.** Implement a debug adapter and get VS Code's call stack,
breakpoints, watch, variables, and disassembly views with zero fork changes.
Fast, but DAP is source-line-centric with no concept of address spaces, physical
memory, or Moments — it will fight everything after P4.

**Option B — native views in `contrib/delverDebug/`.** More work, but the views
speak `ILocation` and `IMoment` natively, and nothing has to be unwound later.

**Recommendation: B for the core views** (breakpoints, call stack, stepping
commands), because they're small and they're where the address model matters
most. Keep A available as an optional convenience layer if someone wants to drive
Delver from familiar debug UI — but the native provider interface stays the
source of truth, and the shim never leaks its model downward.

---

## Operational notes

- **Do not run this on your workstation against real malware.** Use the remote
  provider mode from [03-Target-Providers.md](target-providers.md): the
  provider inside the analysis VM, the IDE on the host.
- Attaching requires appropriate privileges; PPL and protected processes cannot
  be opened at all. Report that clearly rather than failing obscurely.
- **EDR and AV will flag `provider-winproc`.** It reads other processes' memory
  and installs breakpoints — that is textbook suspicious. Plan for code signing
  and documented exclusions for the team's machines. Discover this now, not the
  day before a demo.
- Every read path is a fuzzing target. A hostile process can hand back
  deliberately corrupt structures, and unmapped memory can race with reads.

## Exit criteria

Attach to a running process, freeze it, set a breakpoint on a module export, hit
it, read registers and the call stack, step one instruction, diff the loaded
module against its file on disk, and detach without killing the target.

And the real test: **none of this required a change to `ITargetProvider`.** If it
did, the abstraction was wrong — fix it before P5, while there are still few
providers to reconcile.
