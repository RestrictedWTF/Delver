# Connecting an external agent

Delver exposes its analysis to any MCP client through `delver-mcp`, a standalone
stdio adapter that ships with the application. This page is the published
integration surface: the generic `.mcp.json`, the per-client recipes, and what
the first tool call does.

Design lives in
[`planning/ai-integration-plan.md`](../planning/ai-integration-plan.md) §7 and
[`architecture/security-model.md`](../architecture/security-model.md). This page
describes only how to wire a client up.

## What the client gets

Sixteen read and navigation capabilities, identical to the ones the in-workbench
chat uses, because both go through the same dispatcher:

`delver_capabilities` · `delver_session_info` · `delver_current_context` ·
`delver_focus` · `delver_image_info` · `delver_list_functions` ·
`delver_lookup_function` · `delver_disassemble` · `delver_decompile` ·
`delver_xrefs_to` · `delver_xrefs_from` · `delver_list_strings` ·
`delver_search_strings` · `delver_imports` · `delver_exports` ·
`delver_get_interpretation`

Tool names, schemas, and descriptions are discovered from the running window
through `tools/list`. The adapter does not carry its own copy, so a client can
never advertise a capability the window lacks.

`delver-mcp` negotiates MCP protocol revisions from `2024-10-07` through
`2025-11-25` and speaks newline-delimited JSON-RPC over stdio. Streamable HTTP is
deliberately not implemented; every client gets its own private adapter process.

## Before it will connect

The adapter reaches exactly one Delver window, selected by workspace root. That
window must:

- have **exactly one** folder open, on a local file system;
- be a **trusted** workspace — Restricted Mode publishes nothing;
- not be remote, virtual, or an untitled multi-root workspace; and
- run on Windows, macOS, Linux, FreeBSD, or OpenBSD.

The `--root` you configure must be that same folder, as an absolute path. There
is no working-directory fallback: without an explicit root the adapter would
reach whichever window happened to start last.

## Getting the exact configuration

Run **Delver: Copy External Agent (MCP) Configuration** from the Command
Palette. It copies the recipe for the current window — resolved adapter path,
resolved root, and this application's name as the approval label — or tells you
the one reason the window cannot publish one. Prefer it over hand-writing paths.

## The generic recipe

Every client below is a rearrangement of this. Both paths are absolute; the
adapter is the staged executable, not a name on `PATH`.

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

`--display-name "<label>"` is optional. It is shown in the approval prompt as an
explicitly unverified, client-supplied label; it is never identity, and the grant
is made against the OS-attested process instead.

The staged adapter lives at:

| Build | Path |
| --- | --- |
| Development checkout | `<repo>/delver/target/debug/delver-mcp[.exe]` |
| Packaged application | `<app>/resources/delver/bin/<platform>/delver-mcp[.exe]` |

## Client recipes

The file locations below come from each client's own documentation. None of
these clients has been through the P3b conformance run yet — what has been
exercised end to end is a raw reference client over the real bootstrap and DTP
path — so confirm the location against your client's current docs if it does not
pick the server up.

### Claude Code

Project scope — write the generic recipe above to `.mcp.json` in the workspace
root, or add it from the CLI:

```console
claude mcp add delver --scope project -- /absolute/path/to/delver-mcp --root /absolute/path/to/workspace
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.delver]
command = "/absolute/path/to/delver-mcp"
args = ["--root", "/absolute/path/to/workspace"]
```

### Cursor

`.cursor/mcp.json` in the workspace, or `~/.cursor/mcp.json` for every project.
Both take the generic `mcpServers` document verbatim.

### Kimi

Kimi's CLI reads the same `mcpServers` document; place it in the MCP
configuration file its docs name for your install. No Delver-specific fields are
involved.

### Delver's own workbench

Delver inherits VS Code's MCP client. `.vscode/mcp.json` in the workspace uses
the same server entry under `servers` rather than `mcpServers`. This is useful
for driving one window from another; a window does **not** need this file to use
its own built-in chat tools, which never go through MCP.

### A minimal reference client

Anything that can spawn a process and speak MCP over stdio works:

```console
/absolute/path/to/delver-mcp --root /absolute/path/to/workspace
```

Then write `initialize`, `notifications/initialized`, and `tools/list` as
newline-delimited JSON-RPC on stdin. stdout carries protocol bytes only.

## What happens on the first call

Starting the process costs nothing and prompts nobody: it opens no target,
starts no analysis, and starts no decompiler. `delver_capabilities` answers with
no project open.

The first `tools/list` or `tools/call` performs discovery and authentication:

1. the adapter fingerprints `--root` and selects the matching published window;
2. it makes a one-shot bootstrap claim to that window;
3. the window shows a modal offering **Allow Once** and **Deny**, with the
   OS-attested process and user shown separately from the unverified client name;
4. **Allow Once** issues a single-use, 15-second credential for one private
   connection, which the adapter consumes immediately.

The grant covers that one connection. Restarting the client prompts again.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `no Delver window matches the requested root` | No eligible window has that exact folder open, or the window is in Restricted Mode. Check the four conditions above. |
| `N Delver windows match the requested root` | Two windows have the same folder open. Close one; routing is deliberately not a guess. |
| `the Delver rendezvous directory is not private to the current user` | The per-user Delver directories failed their owner/permission audit. This fails closed and is never repaired automatically. |
| No prompt appears | The client has not called a tool yet. Discovery is lazy by design. |
| `TARGET_NOT_ATTACHED` from disassembly or xrefs | A saved `.delverdb` is open without its sample. Saved pseudocode still answers; ask the analyst for the bytes rather than concluding the function is empty. |

## Security notes

- The rendezvous registry is **non-secret**: it publishes a bootstrap endpoint,
  window generation, and root fingerprint — never a token, path, or target
  metadata. The credential is issued only after an explicit grant.
- Client-supplied names are labels, not identity, anywhere in this path.
- Sample-derived payloads — strings, symbol names, pseudocode identifiers — are
  marked `untrusted` in provenance. They are data for a model to reason about,
  never instructions for it to follow.
- Disconnecting a client cancels its in-flight requests and affects nothing else:
  the project, the analysis server, and the decompiler worker keep running.
