# Linux filesystem and extension compatibility

## Ownership policy

Linux support belongs as close as possible to the code that needs it:

- Bundled extensions in `extensions/` are part of Vortex and implement their Linux behavior here.
- Official Nexus Mods extensions maintained in separate repositories may be patched in local
  checkouts for integration testing. Their source changes must ultimately be submitted upstream.
- Unofficial community extensions are not rewritten. Vortex provides generic filesystem and
  Windows-tool compatibility at the extension API boundary, and any remaining extension-specific
  work is documented for its maintainer.

This avoids hard-coding knowledge of individual official extensions in Vortex core while preserving
compatibility for existing community extensions.

## Filesystem behavior

Linux filesystems are normally case-sensitive while Windows games and extensions commonly are not.
Modules loaded from an extension receive filesystem proxies for the Vortex API, `fs`, `fs/promises`,
and `original-fs`. They accept Windows separators and resolve existing path components without case
sensitivity. Writes reuse the spelling already on disk, preventing parallel `Data`/`data` or
`Plugins`/`plugins` directories.

Deployment uses the same canonical path rules while planning links, including paths that do not yet
exist. This is generic behavior and is not tied to Skyrim or any other game.

## Bundled LOOT support

`gamebryo-plugin-management` owns its platform boundary:

- Its build packages `libloot.dll` on Windows or `libloot.so.0` on Linux.
- Linux uses a Unix socket in the temporary directory for the existing LOOT worker protocol.
- Game paths are resolved to their real on-disk spelling before native LOOT receives them.
- Plugin names sent to LOOT retain the deployed file's actual casing.
- The worker starts in the same temporary directory as its Unix socket.

The Linux package currently stages tested native runtime files from `src/main/assets/loot-linux/`
into the extension dependency before invoking the extension-owned packaging script. Their SHA-256
checksums are:

```text
26a2d1ab7fa2d8ef73ac4d62d0a25724478df81ba9f14ac122a37cf9e19eca7b  libloot.so.0
17f3e5b8bb96f988046f229480c80653200f154be3abbf9f586c3648db7f1c16  node-loot.node
```

## Changes required outside this repository

| Repository                          | Required upstream change                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official `node-loot` package        | Select a Unix socket endpoint on non-Windows instead of emitting a Windows named-pipe path.                                                                                                           |
| Official `node-loot` package        | Add Linux `binding.gyp` link settings for `libloot.so.0`, including an `$ORIGIN` runtime search path.                                                                                                 |
| Official `node-loot` package        | Use narrow native filesystem paths on non-Windows and guard Windows-only `std::wstring` N-API conversions.                                                                                            |
| Official external Vortex extensions | Use the Vortex filesystem API for game files where possible, preserve detected filename casing, and launch Windows helpers through `api.runExecutable` so Vortex can select the game's Proton prefix. |
| Unofficial community extensions     | No mandatory source rewrite. Report extension-specific assumptions that cannot be handled by the generic API boundary to the maintainer.                                                              |

Official external-extension changes can be applied to local checkouts for end-to-end testing, but
must not be represented as shipped until their own repositories publish them.

## Profile files

Profile switching waits for every extension's `profile-will-change` persistence task before copying
profile-owned files. This core transaction guarantee prevents delayed writes from replacing a newer
profile snapshot and is not Gamebryo-specific.

## Local verification

```bash
pnpm --filter gamebryo-plugin-management test
pnpm --filter gamebryo-plugin-management typecheck
node src/main/copy-extensions.mjs
ldd src/main/build/bundledPlugins/gamebryo-plugin-management/node-loot.node
```

The final check must resolve `libloot.so.0` beside the packaged native addon, not from a build-machine
path.
