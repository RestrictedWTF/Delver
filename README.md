# Delver

Delver is an open-source reverse-engineering workbench built on Code - OSS. It brings binary analysis, decompilation, durable investigation state, and grounded AI tooling into one editor-style interface. The current prototype focuses on static analysis of PE files for x86 and x64.

> Delver is under active development. Interfaces and project formats may change before the first stable release.

## Current features

- Native PE parsing and x86/x64 analysis, including sections, functions, imports, exports, strings, and cross-references.
- A virtualized disassembly listing with go-to, follow/return, navigation history, synchronized focus, and function-aware labels.
- Dedicated Overview, Functions, Sections, Imports, Exports, References, and Strings views.
- Ghidra 12.1 decompilation through a persistent PyGhidra worker, with an explicit headless fallback and synchronized pseudocode-to-listing navigation.
- Append-only, attributed renames, comments, and tags with undo, author reversion, import/export, and proposal-resolution support.
- Portable SQLite `.delverdb` projects that preserve analysis, pseudocode, interpretation, provenance, and revisions without embedding the original binary.
- Sixteen bounded, provenance-aware agent capabilities for built-in chat and external MCP clients, with local authorization, cancellation, and root-scoped transport.
- A Rust analysis pipeline, versioned RPC protocol, generated TypeScript types, headless `delverctl`, and a synthetic regression corpus.

## Project structure

```text
delver/                         Rust analysis engine, protocol, providers, CLI, and MCP adapter
src/vs/platform/delver/         Shared Delver types and native platform services
src/vs/workbench/services/delver/ Session, focus, project, decompiler, and agent services
src/vs/workbench/contrib/delver*/ Workbench views, editors, navigation, and AI tools
extensions/delver-agent-bridge/ External-agent authorization and transport bridge
scripts/ghidra/                 PyGhidra worker and headless Ghidra integration
build/lib/delver/               Build, launch, and protocol-generation tooling
Docs/                           Architecture, development notes, plans, and status
```

## Roadmap

| Phase | Focus | Status |
| --- | --- | --- |
| P0-P1 | Native pipeline, PE static analysis, listing, navigation, and interpretation | Implemented |
| P2 | Portable projects and backend-neutral decompilation | Core flow implemented; UI polish, p-code, and IDA/Hex-Rays remain |
| P3 | Grounded AI tools, proposals, evidence, review, Python client, and notebooks | In progress; read-only tools and MCP bridge are implemented |
| P4 | Live process attach, debugging, memory views, and memory-vs-disk diff | Planned |
| P5-P6 | Types, CFGs, more formats/providers, signatures, recipes, and hardening | Planned |
| P7 | Kernel and hypervisor providers | Parked |

See the [detailed roadmap](Docs/planning/roadmap.md), [feature ledger](Docs/planning/ledger.md), and [current status](Docs/planning/status.md) for implementation-level detail.

## License

Delver is based on [Code - OSS](https://github.com/microsoft/vscode) and is available under the [MIT License](LICENSE.txt).
