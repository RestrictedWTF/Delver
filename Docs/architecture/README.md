# Architecture

**The standing design.** How the system is built and why. If something here is
wrong, fix it here — these docs are authoritative, and chat is not.

Changing a decision in this folder means writing an ADR in
[`../history/adr/`](../history/adr/) that records the move.

| Doc | Covers |
| --- | --- |
| [data-model.md](data-model.md) | Address spaces, `Moment`, facts vs. interpretation, anchors, the graph layer, storage, performance budget |
| [session-persistence.md](session-persistence.md) | Untitled and saved sessions, save prompts, portable `.delverdb`, backend caches, invalidation |
| [target-providers.md](target-providers.md) | Capability negotiation, `ITargetProvider`, out-of-process transport, the provider roadmap |
| [ide-architecture.md](ide-architecture.md) | Where code lives in the fork, what to reuse from VS Code, the focus bus, view-by-view notes, scripting |
| [project-structure.md](project-structure.md) | Directory layout, Rust crate boundaries, protocol codegen, naming, build wiring |
| [ai-analyst.md](ai-analyst.md) | Tools, grounding, the proposal layer, notebooks, prompt injection, evals |
| [security-model.md](security-model.md) | Threat model, process boundaries, untrusted content, data handling |
| [root-fingerprint.md](root-fingerprint.md) | Normative `root-v1` workspace routing and cross-platform conformance vectors |

## Component specs

Specs for individual components, as they get designed.

| Doc | Component |
| --- | --- |
| [debugger-provider.md](debugger-provider.md) | The Windows live-process provider, staged D0–D3 |

## What belongs here vs. elsewhere

- **Here:** the design as it currently stands.
- [`../planning/`](../planning/) — when it gets built, and ideas not yet decided.
- [`../design/`](../design/) — what a surface looks like and how it behaves.
- [`../history/`](../history/) — what we used to think, and why it changed.
