# aether-vfs deployment (design)

Status: design for the `aether-vfs` branch (based on `linux`). It replaces hardlink, symlink and
move deployment with [aether-vfs](https://github.com/doodlum/aether-vfs): mods are composed into a
virtual view of the game folder instead of being linked or moved into it. The game install stays
untouched.

## Goals

- **Full replacement.** Every game that today deploys with links deploys through the VFS: 64-bit
  and 32-bit Windows games on Windows, Windows games under Proton, and native Linux games.
- **Migration.** A Vortex that deployed with links (any earlier version) is moved over
  automatically: its deployment is purged with the method that made it, originals are restored,
  and the game is redeployed virtually. Nothing in the game folder is left behind.
- **Stock Steam on Linux.** Use the game's own Steam Proton and prefix, never a separate runtime.
- aether-vfs changes live on its `vortex-integration` branch; its `master` is not modified.

## The visibility problem

aether-vfs on Windows virtualises a process by injecting a shim into it. Only processes that the
session launches see the mods. Vortex, however, reads the deployed folder in several places
outside any game launch:

| Reader                                                                      | What it needs                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| Gamebryo plugin list (`updatePluginList`), missing masters, archive checks  | directory listings and plugin bytes in `Data`     |
| File-time load order for Oblivion, Fallout 3, New Vegas (`PluginPersistor`) | setting and reading plugin mtimes                 |
| LOOT (native libloot, in-process C++)                                       | reads `Data` itself, outside Node                 |
| Tool discovery, primary-tool validation, script-extender version checks     | `requiredFiles` and loaders in the game folder    |
| Merging (`modMerging`)                                                      | original game files (now always pristine on disk) |
| new-file-monitor, external changes                                          | what the game and tools wrote                     |
| Steam `-applaunch`, store URLs, Xbox                                        | the launcher starts the game, not Vortex          |

So the VFS view has two consumers: launched programs, and Vortex itself.

## Architecture

### 1. The deployment method

A new method, `aether_vfs` (name "Virtual file system"), registered by a new bundled extension
`vfs_deployment`, replaces the link methods as the only selectable method (the null method stays
for games that declare `compatible.nulldeployment`).

- `prepare` / `activate` / `deactivate` reuse the link bookkeeping (`LinkingActivator`'s
  per-file map, last writer wins, blacklists, file overrides, merged sources), but `finalize`
  performs no file operations. Its result is the **virtual deployment**: for each mod type,
  `virtual path -> staging file`.
- The manifest is written to staging (`<staging>/vortex.deployment[.type].json`), never to the
  game folder, with `deploymentMethod: "aether_vfs"`.
- `purge` clears the virtual deployment. `externalChanges` reports what programs wrote to the
  **write layer** (below), so the existing External Changes dialog can import or drop it.
- Mod types whose target is outside the game folder (Documents, AppData, prefix user folders) are
  separate roots of the same session.

### 2. The write layer ("Overwrite")

Files a game or tool creates or changes inside a virtual root land in a per-game write folder,
`<staging>/__vfs_overwrite/<root>`, never in the game install. Vortex shows it as a special mod
that can be cleared, or whose files can be imported into a mod (the External Changes flow). Saves
and settings outside the game folder are not virtualised and stay where the game writes them.

### 3. Windows: per-launch injection

Every program Vortex starts for a game runs through one session per game (`@aether-vfs/node`):

- `runExecutableDirect` hands Windows executables of a VFS-deployed game to the session's
  `launch` instead of `spawn`, so the Play button, tools, primary tools and script-extender
  loaders all see the mods. Start hooks still run first. Exit and running state come from the
  launch handle (every process in its Job Object), which keeps `toolsRunning` correct.
- Store launches are replaced by direct launches with the store's environment (`SteamAppId`,
  `steam_appid.txt` semantics), which aether-vfs already supports for SteamStub-wrapped games.
  **A game started from Steam's own Play button does not see mods**, as with Mod Organizer 2.
  The Play button in Vortex is the supported way to play.
- Vortex's own readers use a **deployed view** API: `readdir`, `stat` and `read` answered from
  the virtual deployment in-process, plus the real game folder underneath. Plugin mtimes for
  file-time load order are kept as virtual metadata and applied by the shim.
- LOOT runs in a helper process (`ELECTRON_RUN_AS_NODE`) that the session launches, so native
  libloot reads the composed `Data` folder.

### 4. Linux: a FUSE mount

On Linux the view is a FUSE filesystem served by the same provider graph (a new aether-vfs crate,
`vfs-fuse`), mounted over each root for as long as the game is managed:

- Process-independent: native Linux games, Windows games under Steam's own Proton and prefix,
  Steam's Play button, LOOT and every Vortex reader see the composed folder with no injection
  and no GE-Proton.
- The base layer reads the real folder through a directory descriptor opened before mounting.
- Flatpak Vortex mounts with `fusermount3` on the host (`flatpak-spawn --host`).
- Unmounted on purge, game switch and exit. A crashed session is lazily unmounted at the next
  start.

### 5. 32-bit games

aether-vfs gains an x86 build: `vfs-ntlayout` with 32-bit layouts, the shim and its hooks, and
`vfs-injector32.exe`. A 64-bit Vortex launches a 32-bit game through the 32-bit injector; the ring
is fixed-width, so the same director serves both (asserted at compile time on both targets).

## Migration

A core migration runs once, when this version first starts:

1. For each game with a link-based method, or with a link manifest in its game or staging folder,
   mark the game for migration (`settings.mods.vfsMigration[gameId] = "pending"`).
2. When that game is next active, purge with the **manifest's** method (the link methods stay in
   the code for purging only and are not selectable), restoring `.vortex_backup` originals and
   removing the tag files. Then set `aether_vfs` and redeploy.
3. A purge that fails leaves the game on its old method and reports the error with the existing
   Fix Deployment dialog. Nothing is switched until the game folder is clean.
4. Manifests left by another instance or a removed method use the existing fallback purge.

Downgrading to an older Vortex finds a clean game folder and an unknown method; the older version
then asks for a method and deploys with links again.

## Work order

1. aether-vfs: Node binding (`bindings/node`, per its approved design) with the `vfs-embed`
   additions it needs; Windows x64 end to end with a fixture.
2. Vortex: the `aether_vfs` method, write layer, deployed view, launch routing, migration; tests
   and a real Skyrim SE deploy and launch on Windows.
3. aether-vfs: `vfs-fuse`; Vortex: Linux mounting; real Stardew (Proton) and a native Linux game.
4. aether-vfs: x86 build; Vortex: Fallout New Vegas or Oblivion on Windows.
5. Remove link deployment from the selectable methods; documentation, nightlies.
