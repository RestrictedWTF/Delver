# Security Model

Delver is an IDE that deliberately opens hostile files. That inverts the usual
threat model: the *content* is the adversary, and the IDE is the target. Most RE
tools have shipped remote-code-execution bugs in their parsers; assume Delver
will too, and design so that it costs an attacker a sandbox escape rather than a
malformed header.

---

## 1. Threat model

| # | Threat | Vector |
| --- | --- | --- |
| T1 | Parser exploitation | Malformed PE/ELF/dump crafted against the loader or disassembler |
| T2 | Accidental execution | Sample launched, DLL loaded into a Delver process, script auto-run |
| T3 | Renderer injection | Sample strings rendered as HTML/markdown/terminal escapes |
| T4 | Prompt injection | Sample text steering the AI's conclusions ([05-AI-Analyst.md](ai-analyst.md) §5) |
| T5 | Exfiltration | Sample or analysis data leaving the host — telemetry, AI provider, extension |
| T6 | Accidental redistribution | Sharing a `.delverdb` project that embeds live malware |
| T7 | Scripting endpoint abuse | Any local process reaching the DTP session endpoint gains memory read/write on the attached target |
| T8 | Anti-analysis / target escape | The sample detecting or attacking the provider |

## 2. Process boundaries

The boundary map, from most to least trusted:

```
Renderer (workbench UI)          — never parses sample bytes, never executes them
  │  JSON-RPC + binary frames
Analysis server (sandboxed)      — parsers, disassembler, decompiler
  │  JSON-RPC + binary frames
Target provider (sandboxed)      — touches the live target / sample file
  │
Target                           — hostile, ideally on a different machine
```

Rules:

- **The renderer never runs a parser over target bytes.** Not a PE header
  parser, not a string extractor, not "just a quick one for the hex view".
  Everything derived from sample bytes arrives as already-validated structured
  data over the protocol.
- **Providers and the analysis server run sandboxed.** On Windows: restricted
  token, low integrity, AppContainer where practical, job object limits, no
  network. On Linux: seccomp-bpf plus a user namespace.
- **Providers are restartable.** A crash is an expected event with a
  reconnect path, not a workspace-ending error.
- **Remote providers are the recommended configuration for live malware.** The
  provider runs inside the analysis VM; the IDE runs on the host. The sample
  never touches the machine you read email on. This falls out of the transport
  choice in [03-Target-Providers.md](target-providers.md) — make it a
  documented, first-class deployment mode, not an afterthought.

## 3. Never execute the target (T2)

Non-negotiable invariants:

- Delver never `LoadLibrary`s or executes a sample or any of its code, in any
  process, for any reason. Emulation happens in an emulator provider, in its own
  sandbox.
- Symbol servers and PDB loading are a real attack surface — treat downloaded
  PDBs as untrusted input parsed in the sandbox, and never load a PDB path
  supplied by the sample without confirmation.
- The workspace-trust model already in VS Code covers auto-running tasks and
  extensions. Delver should default a project containing captured sample bytes
  to **restricted** trust, and say why.
- Never write a sample to a path where an OS component will scan, index, or
  execute it, and never with an executable extension in a user-writable
  auto-run location.

## 4. Untrusted content rendering (T3)

Sample-derived strings are attacker-controlled and appear in trees, tables,
markers, chat, notebook output, and hovers.

- Escape or strip control characters, terminal escape sequences, bidi override
  characters, and zero-width characters before display; render them as visible
  escapes instead. VS Code already has unicode-highlight machinery for the bidi
  and confusable-character cases — reuse it.
- Never render sample-derived text as markdown or HTML. Not in chat, not in
  hovers, not in notebook output.
- Truncate at display time with an explicit "show full value" action. A 4 MB
  "string" should not lock the UI.
- Filenames from samples are not safe filenames. Never use one directly to
  construct a path.

## 5. Data handling (T5, T6)

- **Telemetry off by default**, and loud about it. Analysts handle other
  people's incident data under NDA.
- **AI providers see sample content.** This must be an explicit, visible,
  per-workspace decision, with a clear indicator when a request will include
  sample-derived bytes or strings, and a supported fully-local model
  configuration for classified work. Getting this wrong is an existential
  product risk, not a feature gap.
- **Separate analysis from samples on disk.** Keep captured bytes in a distinct
  file from the analysis database, so `project.delverdb` can be shared without
  shipping `project.delverdb.samples`. Sharing a project must never silently
  redistribute malware.
- Any embedded sample bytes in an exported artifact should be encrypted or
  password-protected by default, following existing malware-sharing convention.

## 6. Extensions (T7)

Scripting reaches the workbench through a **local DTP endpoint**
([04-IDE-Architecture.md](ide-architecture.md) §5). That endpoint grants
arbitrary memory read and write on whatever is attached, so an unauthenticated
one is a genuine vulnerability, not a theoretical one — and the machine it runs
on is by definition handling malware.

- **Windows:** named pipe with a per-session random name and an ACL restricted
  to the current user. **POSIX:** Unix socket in a mode-0700 directory. Never a
  TCP listener for the local session endpoint, not even on loopback.
- **Token-auth every connection.** The token goes in `DELVER_SESSION` alongside
  the endpoint address, is regenerated per session, and is never written to disk
  or logged.
- Write and network operations are logged by client identity. The interpretation
  layer's audit trail covers scripts for free, since a script is an author like
  anything else ([02-Data-Model.md](data-model.md) §3).
- Consider a confirmation prompt for a script's *first* write in a session. A
  read-only script is routine; one that mutates the analysis should be a
  deliberate act.
- Third-party VS Code extensions inherit the terminal environment and therefore
  `DELVER_SESSION`. Treat installing an untrusted extension as granting target
  access, and keep workspace trust engaged.

If a TypeScript extension API is ever added, gate target access behind a
capability declared in the extension manifest and surfaced at install time.

## 7. Anti-analysis and provider hardening (T8)

- Assume the target may detect the provider and behave differently. Surface
  detection artifacts to the analyst rather than pretending they don't exist —
  a provider should report its own observability characteristics.
- Assume the target may attack the provider: hostile page contents, deliberately
  corrupt structures, unmapped memory racing with reads. Every provider read
  path must be fuzzed. This is the single highest-value fuzzing target in the
  codebase.
- Provider crashes are data: repeated crashes at the same structure are worth
  reporting as a finding, because they often mean deliberate anti-analysis.

## 8. Practices

- **Fuzz the parsers.** PE, ELF, Mach-O, minidump, and the protocol decoder.
  Continuous, in CI, with a persistent corpus. Non-negotiable for T1.
- Write parsers in a memory-safe language. This is the strongest single argument
  for Rust in the analysis server.
- Keep a `Docs/threat-model` review checkpoint before any release that adds a
  new provider or a new parser.
- Track and update every third-party analysis component. A vendored copy of a
  decompiler from three years ago is a liability.
