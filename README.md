# Delver

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/License-MIT-4c566a" alt="License: MIT"></a>
  <a href="https://doc.rust-lang.org/edition-guide/rust-2021/index.html"><img src="https://img.shields.io/badge/Rust-2021-4c566a?logo=rust&amp;logoColor=white" alt="Rust 2021"></a>
</p>

Delver is a reverse engineering workbench built on Code - OSS.
The Rust engine analyzes PE files for x86 and x64.
The editor presents disassembly, decompilation, and saved investigations.

Delver remains under development.
Interfaces and project formats can change.

## Features

- The engine reads sections, functions, imports, exports, strings, and references.
- The disassembly listing supports navigation history and synchronized selection.
- The workbench provides views for functions, sections, imports, exports, references, and strings.
- The Ghidra integration provides decompilation through a persistent PyGhidra worker.
- The workbench retains attributed renames, comments, tags, and review decisions.
- SQLite `.delverdb` files retain analysis and investigation state.
- Project files identify the original binary through its hash without embedding its bytes.
- MCP tools expose analysis, navigation, proposals, and findings to external clients.
- The `delverctl` command provides analysis operations without the editor interface.

## Build the Rust components

The Rust workspace contains the engine, providers, analysis server, and command tools.

```sh
cargo build --manifest-path delver/Cargo.toml --workspace --release
```

Cargo writes the executables under `delver/target/release`.
Windows adds the `.exe` extension.

The command tool can analyze a file without starting the editor:

```powershell
.\delver\target\release\delverctl.exe analyze C:\path\to\program.exe
```

## Build the editor

The editor uses Node.js, npm, Electron, and the Rust toolchain.
Use the Node.js version in [`.nvmrc`](.nvmrc).
Install the Code - OSS native build dependencies for your platform.
The [contribution guide](CONTRIBUTING.md) links the upstream build documentation.

These scripts run from the repository root:

```sh
npm ci
npm run delver:build
npm run compile
npm run delver:launch
```

The development launcher starts an isolated editor profile.
Ghidra decompilation requires a configured Ghidra installation and PyGhidra environment.
The [Ghidra scripts](scripts/ghidra) contain the worker and headless integration.

## External agents

The `delver-mcp` adapter connects an MCP client to a running Delver window.
The adapter requires an explicit workspace root.
The window controls authorization and advertises its available tools.

Read the [external agent guide](Docs/development/external-agents.md) for configuration and connection requirements.

## Project structure

| Path | Responsibility |
| --- | --- |
| [`delver`](delver) | Implements analysis, providers, the protocol, command tools, and the MCP adapter. |
| [`src/vs/platform/delver`](src/vs/platform/delver) | Defines shared types and native platform services. |
| [`src/vs/workbench/services/delver`](src/vs/workbench/services/delver) | Manages sessions, projects, focus, decompilation, and agent services. |
| [`extensions/delver-agent-bridge`](extensions/delver-agent-bridge) | Connects authorized external agents. |
| [`scripts/ghidra`](scripts/ghidra) | Runs Ghidra decompilation workers. |
| [`build/lib/delver`](build/lib/delver) | Defines build, launch, and protocol generation tools. |
| [`Docs`](Docs) | Records architecture, development guidance, and project status. |

## Checks

The repository defines these Delver checks:

```sh
npm run delver:test
npm run delver:corpus
```

The [development guide](Docs/development/README.md) describes the repository workflow.
The [feature ledger](Docs/planning/ledger.md) records implementation details and remaining work.

## Scope

The current file provider targets PE images for x86 and x64.
Live debugging, additional executable formats, and kernel providers remain roadmap work.
Ghidra provides the current decompiler integration.
Other decompiler providers remain roadmap work.

The [roadmap](Docs/planning/roadmap.md) and [status](Docs/planning/status.md) describe the development plan.

## License

Delver builds on [Code - OSS](https://github.com/microsoft/vscode).
The [MIT license](LICENSE.txt) covers the repository.
Existing Microsoft and third-party notices remain applicable.
