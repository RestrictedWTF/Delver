# Root Fingerprint Protocol

`root-v1` lets an independently launched adapter select the Delver window for
one workspace without publishing its filesystem path. The fingerprint is
non-secret routing metadata. It is not client identity, authorization, proof of
path access, or target identity.

## Input and resolution

The publisher and client each require exactly one explicitly selected local
`file`-scheme directory. They must refuse zero or multiple roots, remote and
untitled workspaces, missing or inaccessible paths, and regular files. URI
authorities are refused except for a Windows UNC root whose printable-ASCII
authority case-insensitively equals the UNC server component. A standalone
client must not silently use its current directory.

The implementation bounds both input and resolved paths to 16 KiB in UTF-8,
rejects NUL and unpaired UTF-16 surrogates, calls the native realpath operation,
and verifies that the resolved result is a directory. Realpath follows
symlinks/junctions, so those aliases intentionally share a fingerprint. A
broken link or resolution/stat failure publishes nothing. Root-v1 is namespace
identity: hard-link, mount, mapped-drive, and UNC aliases need not match.

## Canonical form

The resolved path becomes `{ kind, path }`, where `kind` is exactly one of
`win32-drive`, `win32-unc`, `darwin`, `linux`, `freebsd`, or `openbsd`.
Unsupported platforms fail closed. A canonicalizer must reject dot components,
duplicate separators, or other resolver output outside this contract instead
of lexically repairing it.

For `win32-drive`:

- accept an absolute drive path or the safe native-realpath form
  `\\?\C:\...`;
- uppercase only the ASCII drive letter and use `/` separators;
- preserve realpath-provided component case and Unicode spelling;
- remove a trailing slash except for the volume root `C:/`; and
- reject drive-relative paths, ADS, and every other device/NT namespace.

For `win32-unc`:

- accept `\\server\share\...` or the safe native-realpath form
  `\\?\UNC\server\share\...`;
- require nonempty printable-ASCII server/share components without control
  characters or `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, or `*`;
- lowercase the ASCII server and share, use `/` separators, preserve path
  component case/Unicode, and omit the trailing share/path slash; and
- reject missing shares, device UNC paths, `GLOBALROOT`, volume GUIDs, pipes,
  and all other namespaces.

For POSIX kinds, require one absolute `/` path, preserve case and exact valid
UTF-8 spelling, and remove only a trailing slash outside `/`. Root-v1 performs
no Unicode normalization on any platform: NFC and NFD paths can identify
different directories.

## Hash

Hash this byte sequence with SHA-256 and encode it as exactly 64 lowercase
hexadecimal characters:

```text
ASCII("delver-root-v1") || 0x00 || ASCII(kind) || 0x00 || UTF8(path)
```

There is no JSON framing, salt, locale-dependent operation, platform-default
encoding, user/machine identifier, trailing NUL, or newline.

## Conformance vectors

| Kind | Canonical path | Fingerprint |
| --- | --- | --- |
| `win32-drive` | `C:/Users/Alice/Project` | `f2ba3910dff6197279ca1c4f671d85f3b6014580b4ef125e0637e9a97fb49f6d` |
| `win32-drive` | `C:/` | `f2875af4ccc606fdeb4b57526a7bc88dbdb7d789bedc17059703c56e18cbbe38` |
| `win32-unc` | `//server/share/Project` | `62f8b7c0156774720c4178969dd4970cfcaf39b08433948a04431ec3081b9f27` |
| `linux` | `/home/alice/project` | `9994d17eec447dc153e2be8d9f4602b5031539bb1452487512e2c8f12c6d6731` |
| `darwin` | `/Users/Alice/Café` | `5202f76b7bd885e7764e201e634f504681dda90d5d797e383911ec1e42d4eb8e` |
| `darwin` | `/Users/Alice/Cafe` + U+0301 | `b5de87e0c91fe13c369397c330b5c326a756df3264aa748206eea96c388fcf56` |
| `linux` | `/tmp/Café` | `63c87baa8da05c2bee4e7b3969ae8e7227e713482c10e25b2c0b3db774617911` |
| `linux` | `/tmp/Cafe` + U+0301 | `93e8efd0975cfbaf85d460b98246e24543a61d394566d40625903691efb5e091` |

Registry discovery uses this value only to find candidates. The bootstrap claim
still repeats the registry entry, window generation, and fingerprint, and the
connection still requires kernel-derived peer attestation plus an explicit
one-shot user grant.
