# Rebranding Plan

Turning the fork from "Code - OSS" into Delver. Expands the
`Branding, telemetry off, CI` row in [roadmap.md](roadmap.md) P0.

Two parts: **identity** (names, IDs, icons, installer) and **theme** (which you
author yourself — this covers the scaffold, the authoring loop, and the
constraints).

---

## Do the identity work now, not later

One reason overrides the rest: **the fork currently ships Microsoft's Windows
identity.**

```
win32MutexName        "vscodeoss"
win32x64AppId         {{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}
win32x64UserAppId     {{CC6B787D-37A0-49E8-AE24-8559A032BE0C}
dataFolderName        ".vscode-oss"
```

Install a dev build with those intact and Windows treats Delver and Code - OSS
as the same application: single-instance handoff sends your Delver launch to a
running Code window, and the installer can upgrade or uninstall over a real
install. Regenerate the GUIDs and the mutex names **before the first packaged
build**, even if nothing else is branded yet.

---

## Part 1 — Identity

### 1.1 Names to decide

| `product.json` key | Suggested | Notes |
| --- | --- | --- |
| `nameShort` | `Delver` | Also the built exe basename on Windows |
| `nameLong` | `Delver` | Window titles, About box |
| `applicationName` | `delver` | The CLI command. No known collision |
| `dataFolderName` | `.delver` | User data in `$HOME` |
| `serverDataFolderName` | `.delver-server` | Only if you keep remote/server builds |
| `urlProtocol` | `delver` | `delver://` deep links |
| `win32DirName` | `Delver` | Install directory |
| `win32NameVersion` | `Delver` | |
| `win32RegValueName` | `Delver` | |
| `win32AppUserModelId` | `Delver.Delver` | Taskbar grouping |
| `darwinBundleIdentifier` | `dev.delver.delver` | Use a domain you control |
| `licenseName` / `licenseUrl` | MIT, your repo | Keep MIT attribution |

**Naming collision to resolve:** the docs currently call the project file a
`.delver` project ([data-model.md](../architecture/data-model.md) §7), and
`dataFolderName` also wants `.delver`. Not a hard conflict, but confusing in
`$HOME`.

Recommendation: **`dataFolderName: ".delver"`** (matches the `.vscode`
convention) and rename the project file to **`.delverdb`** — descriptive, and it
follows the short-extension tradition of `.i64`, `.gpr`, `.bndb`. Avoid `.dlv`;
that's the Go debugger's CLI name.

### 1.2 Regenerate every GUID and mutex — **S**

Four app IDs (`win32x64AppId`, `win32arm64AppId`, `win32x64UserAppId`,
`win32arm64UserAppId`), plus `win32MutexName`, `win32TunnelServiceMutex`,
`win32TunnelMutex`. Fresh GUIDs, Delver-specific mutex strings.

Note the doubled brace in the existing values (`{{D77B...}`) — that's the Inno
Setup escape and must be preserved in the new ones.

### 1.3 Gallery and telemetry — **S**

- Point `extensionsGallery` at Open VSX or a self-hosted gallery. **Microsoft's
  marketplace terms do not permit non-VS Code clients** — this isn't optional.
- Clear the telemetry keys and default telemetry off. Analysts handle other
  people's incident data.
- Clear `reportIssueUrl`, `webviewContentExternalBaseUrlTemplate`, and the
  update URL, or point them at your own infrastructure.

### 1.4 Icons — swap contents, keep filenames — **M**

The build scripts reference these by literal path — for example
`build/gulpfile.vscode.win32.ts:151` hardcodes
`resources/win32/code.ico`.

**Replace the file contents and keep the filenames.** Zero patch surface on the
build scripts, which is worth more than tidy naming.

| File | Purpose |
| --- | --- |
| `resources/win32/code.ico` | Windows app + installer icon |
| `resources/win32/code_70x70.png`, `code_150x150.png` | Windows tiles |
| `resources/win32/inno-big-*.bmp`, `inno-small-*.bmp` | Installer artwork, 7 scales each |
| `resources/darwin/code.icns` | macOS app icon |
| `resources/linux/code.png` | Linux app icon |

**File-association icons** (`c.ico`, `cpp.ico`, `jade.ico`, `bower.ico`, …) are
irrelevant to Delver. Trim the association list in `build/win32/code.iss` rather
than redrawing them, and add `.delverdb`.

> **Do not register Delver as the default handler for `.exe`, `.dll`, or
> `.sys`.** Taking `.exe` would break the operating system. If you want them at
> all, register as a secondary "Open with" entry only.

### 1.5 Linux packaging — **S**

Contents change, filenames stay: `resources/linux/code.desktop`,
`code-url-handler.desktop`, `code.appdata.xml`, `code-workspace.xml`, and the
`debian/`, `rpm/`, `snap/` templates.

### 1.6 Installer strings — **S**

`build/win32/code.iss` and `build/win32/i18n/*` carry the product name in
installer UI. Most values come from `product.json` via the gulpfile, so check
what's genuinely hardcoded before editing.

### 1.7 Fallback product name — **S**

`src/vs/platform/product/common/product.ts` carries the fallback used when
`product.json` isn't present. Most of the 135 "Code - OSS" hits under `src/` are
test fixtures and sample data — leave those alone. Fix the one that matters.

### 1.8 Trademark boundaries

The MIT license covers the code, not Microsoft's marks. Concretely:

- Do not ship the Visual Studio Code name, logo, or the blue ribbon icon.
- Keep `LICENSE.txt` and `ThirdPartyNotices.txt` and the MIT attribution.
- "Built on the VS Code open-source codebase" is an accurate factual statement
  and fine. "A version of Visual Studio Code" is not.

---

## Part 2 — Theme

You author the colors. This covers scaffolding, the iteration loop, and the one
constraint that matters.

### 2.1 The constraint: reserve the semantic palette first

[design/principles.md](../design/principles.md) §3 says color encodes meaning
and reserves a fixed set of roles for RE content: control flow, data reference,
string reference, import/thunk, modified bytes, and **uncertainty** (§1).

**Design the theme around those roles from the start.** If you spend the whole
palette on syntax highlighting now, the listing view lands in P1 with no
distinguishable colors left and the theme gets redone.

Mechanically, don't hardcode listing colors in the theme file. Each Delver
contrib registers semantic color IDs via `registerColor()` from
`vs/platform/theme/common/colorRegistry` — the standard VS Code pattern — with
sensible defaults per base theme:

```
delver.listing.controlFlow      delver.listing.dataRef
delver.listing.stringRef        delver.listing.importThunk
delver.listing.functionName     delver.diff.modifiedBytes
delver.state.uncertain          delver.state.stale
delver.state.unreadable         delver.state.proposed
```

`delver.listing.functionName` is registered (2026-08-08) in
`contrib/delverListing/browser/delverListingColors.ts` and is the first of these
actually wired. The rest are still declared in the theme files only — a theme
`colors` entry for an unregistered ID produces no CSS variable, so those four
listing roles currently do nothing. The listing's mnemonic and branch-target
colors still borrow `debugTokenExpression.*` and `textLink.foreground`; moving
them onto this namespace is the remaining work.

Your theme then overrides them in its `colors` block, and so can anyone else's.
Register each ID in the contrib that owns it, as it's built — not all at once
now.

### 2.2 Scaffold — **S**

Copy `extensions/theme-defaults/` as the pattern.

```
extensions/theme-delver/
├── package.json
├── themes/
│   ├── delver-dark.json
│   └── delver-light.json
└── README.md
```

Add it to the built-in extensions list so it ships. Dark is the working default
for this audience; light must be genuinely usable, not an afterthought.

### 2.3 Make it the default — with **zero patch surface** — **S**

`ThemeSettingDefaults` in
`src/vs/workbench/services/themes/common/workbenchThemeService.ts:41-49`
currently reads `COLOR_THEME_DARK = 'Dark 2026'`. Patching it works, but adds a
row to the patch ledger in a file that changes upstream.

**Better:** a built-in extension can contribute `configurationDefaults` in its
`package.json`:

```json
"contributes": {
  "configurationDefaults": {
    "workbench.colorTheme": "Delver Dark"
  }
}
```

That overrides the default with no upstream edit at all. Verify it wins over the
`ThemeSettingDefaults` value on a fresh profile before relying on it; fall back
to the two-line patch if not.

### 2.4 Authoring loop

The fast iteration path, in order:

1. Launch Code OSS from sources (the `launch` skill gives you a throwaway
   profile, so you're not fighting your real settings).
2. Edit colors live via `workbench.colorCustomizations` and
   `editor.tokenColorCustomizations` in settings — these apply **instantly**,
   no reload.
3. When it looks right, run **Developer: Generate Color Theme From Current
   Settings** to dump the result as a theme file.
4. Move that into `themes/delver-dark.json`. Theme file edits hot-reload too.

Iterate in settings, not the theme file. It's dramatically faster.

### 2.5 The other two theme layers

A color theme alone still looks like VS Code. Two optional layers change that,
both deferrable:

- **Product icon theme** — replaces the codicon glyph font. This is what makes
  the chrome stop feeling like VS Code. Supported via
  `src/vs/workbench/services/themes/browser/productIconThemeData.ts`; default is
  `'Default'`.
- **File icon theme** — default is `vs-seti`, which has icons for `.ts` and
  `.jade` and nothing for a PE. Worth a small custom set once Delver opens
  binaries: executables, libraries, drivers, dumps, `.delverdb`.

Both are separate contribution points in the same extension. Do them after the
color theme is settled.

### 2.6 Also carrying the old identity

- **Splash screen** — `src/vs/workbench/contrib/splash/`. It reads theme colors,
  so it mostly follows for free; check it on a cold start.
- **Window title** — driven by `nameLong`, so Part 1 covers it.
- **Welcome / Getting Started** page content still describes VS Code. Low
  priority, but it's the first thing a new team member sees.

---

## Sequencing

| Order | Work | Size | Why here |
| --- | --- | --- | --- |
| 1 | GUIDs, mutexes, `dataFolderName` (§1.2) | S | Blocks safe local installs |
| 2 | Names in `product.json` (§1.1) | S | Cheap, and everything else reads from it |
| 3 | Gallery + telemetry (§1.3) | S | Legal and privacy, not cosmetic |
| 4 | Theme scaffold + default (§2.2–2.3) | S | Unblocks your color work |
| 5 | **You author the theme** (§2.4) | — | Iterate in settings |
| 6 | Icons (§1.4) | M | Needs artwork |
| 7 | Linux packaging + installer (§1.5–1.6) | S | Only when you package |
| 8 | Product icon + file icon themes (§2.5) | M | After colors settle |
| 9 | Welcome page (§2.6) | S | Cosmetic |

Steps 1–4 are an afternoon and unblock everything else.

## Patch surface

Expected new rows in
[patch-surface.md](../development/patch-surface.md):

| File | Change | Risk |
| --- | --- | --- |
| `product.json` | Identity, gallery, telemetry | Medium — upstream edits this often |
| `resources/**` | Icon contents only, filenames unchanged | Low |
| `build/win32/code.iss` | Trim file associations, add `.delverdb` | Low |
| `src/vs/platform/product/common/product.ts` | Fallback name | Low |
| `workbenchThemeService.ts` | **Only if** `configurationDefaults` doesn't win | Medium — avoid |
