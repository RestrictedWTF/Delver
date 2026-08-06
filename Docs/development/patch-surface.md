# Patch Surface

Every upstream (`microsoft/vscode`) file that Delver modifies, and why.

**This file is the fork's maintenance budget made visible.** Upstream moves fast.
New files in new folders almost never conflict; edits to shared registration
files always do. Keeping this list short and known is the difference between a
one-day monthly merge and a one-week one.

## Rules

1. Prefer a new file over editing an upstream one. Always.
2. If you must edit an upstream file, add a row here in the same PR.
3. Keep each edit as small and as mechanical as possible — ideally a single
   import line or a single registry call.
4. Never reformat, reorder, or "clean up" an upstream file. Every unrelated line
   you touch is a future conflict.
5. Mark Delver-specific blocks in upstream files with a `// DELVER:` comment so
   they're greppable during a merge.
6. Re-verify every row after each upstream merge.

## Ledger

| File | Nature of change | Conflict risk | Owner | Notes |
| --- | --- | --- | --- | --- |
| `product.json` | Branding, app IDs, gallery URL, telemetry defaults | Medium | — | Upstream changes this often; expect to re-apply |
| `src/vs/workbench/workbench.common.main.ts` | One import line per Delver contribution | **High** | — | Active: `delverTargetService` and `delverSections` imports under `// DELVER:` marker. Keep all Delver imports contiguous. |
| `src/vs/workbench/services/environment/…` *(TBD)* | Inject `DELVER_SESSION` into terminal + kernel environments | Low | — | Prefer an existing env-contribution point over a direct edit |
| `.eslint-plugin-local/code-import-patterns.ts` | Layer rules for `delver` folders | Low | — | Only if new layer boundaries are introduced |
| `eslint.config.js` | Delver lint rules (`delver-address-is-bigint`, `delver-no-target-kind-branch`) | Low | — | Active: delver file glob with two custom rules |
| `build/gulpfile.ts` | Register the `delver` build task | Low | — | One line; `gulpfile.delver.ts` itself is a new file |
| `src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts` | Register Delver shared-process channel | Low | — | Active: service and channel registration for `IDelverProcessService` |
| `src/vs/workbench/workbench.desktop.main.ts` | Register Delver renderer-side services | Low | — | Active: imports `delverTargetService` and `delverProcessService` |
| `build/gulpfile.vscode.ts` (and platform variants) | Stage provider/analysis binaries into the package | Medium | — | Model on `gulpfile.cli.ts` |
| `package.json` | `delver:*` scripts | Low | — | Active: `delver:build`, `delver:test`, `delver:protocol` |
| `src/vs/workbench/browser/web.api.ts` | Only if Delver needs web-facing config | Low | — | Avoid if possible |

Rows are placeholders until the corresponding work lands. Delete a row if the
change is reverted; never leave stale entries.

## Currently unmodified — keep it that way

These are tempting to edit and should not be. If you think you need to, raise it
first; there is nearly always a contribution point instead.

- **`src/vs/workbench/api/**`** — the three `extHost.*` files are the highest-
  conflict files in the fork. Scripting is Python over DTP specifically so they
  stay untouched ([04-IDE-Architecture.md](../architecture/ide-architecture.md) §5). Only
  revisit for a genuine UI-contributing plugin, as one batched landing.
- `src/vs/workbench/browser/layout.ts`
- `src/vs/workbench/browser/parts/**`
- `src/vs/editor/**`
- `src/vs/workbench/contrib/debug/**` — read it, copy the patterns, don't patch it
- `src/vs/workbench/contrib/notebook/**` — extend via controllers and serializers
- `src/vs/workbench/contrib/chat/**` — extend via the tools registry and MCP

## Merge checklist

Run through this after every `upstream` merge:

- [ ] Every row above still applies; stale rows removed
- [ ] `npm run typecheck-client`
- [ ] `npm run valid-layers-check`
- [ ] Delver contributions still register (launch and check the views appear)
- [ ] Golden-corpus analysis regression suite passes
- [ ] AI eval harness run; grounding/hallucination rates unchanged
