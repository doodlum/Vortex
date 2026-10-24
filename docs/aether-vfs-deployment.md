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

Implemented as follows. The file view shows the write folder on top of the deployment, as the
session does: a written file replaces what is below it, and a `.wh.` deletion marker hides it.
A written file is a real file, so renaming or deleting it acts on the file in the write folder
(deleting a change to a mod's file shows the mod's own file again). The folders are read again
when a session ends. `externalChanges` reports a written file over a mod's as `refchange` and a
deletion as `deleted`, so the External Changes dialog imports or reverts them; a deploy clears
deletion markers over what it deploys. The Mods page's "Generated files" action shows what
programs wrote, opens the folder, makes an enabled, deployed mod of the files they made in the
mod folder, or discards everything.

Files a game or tool creates or changes inside a virtual root land in a per-game write folder,
`<staging>/__vortex_vfs_overwrite/<root>`, never in the game install (the `__vortex` prefix keeps
the staging scan from taking it for a mod). Vortex shows it as a special mod
that can be cleared, or whose files can be imported into a mod (the External Changes flow). Saves
and settings outside the game folder are not virtualised and stay where the game writes them.

### 3. Windows: per-launch injection

Every program Vortex starts for a game runs through one session per game (`@aether-vfs/node`):

- `runExecutableDirect` hands Windows executables of a VFS-deployed game to the session's
  `launch` instead of `spawn`, so the Play button, tools, primary tools and script-extender
  loaders all see the mods. Start hooks still run first. Exit and running state come from the
  launch handle (every process in its Job Object), which keeps `toolsRunning` correct.
- Store launches are replaced by direct launches with the store's environment (`SteamAppId`,
  `steam_appid.txt` semantics), which aether-vfs already supports for SteamStub-wrapped games:
  `StarterInfo` asks the extension's `vfsLaunchesDirectly` API before handing a game to its
  store's launcher. **A game started from Steam's own Play button does not see mods**, as with
  Mod Organizer 2. The Play button in Vortex is the supported way to play.
- Microsoft Store (Xbox app) games start inside their app container, which no session reaches.
  The virtual method reports itself unavailable for them, so they keep the link methods.
- Vortex and its extensions read game folders unchanged. `util/vfsFsView` wraps Node's `fs`,
  `fs/promises` and Electron's `original-fs` at the start of the renderer. `requireRemap` hands
  `original-fs` to graceful-fs and rimraf, so fs-extra and Vortex's `util/fs` read through it.
  Under a virtual deployment:
    - reads, copies, stats, existence checks, real paths and listings see the deployed files;
    - writes, times and truncation of a mod's deployed file reach its staged file, as they did
      through a hard link;
    - renaming a deployed file moves it within the view (plugin ghosting), and renaming a staged
      file or folder keeps what it serves deployed;
    - deleting a deployed file removes it from the view only, sparing staging and any game
      original underneath.

    `util/vfsWalkView` does the same for `turbowalk`, wrapping the module when it is first loaded:
    loading it replaces the global `Promise` with Bluebird, and Vortex's startup depends on when.
    Code that needs the real disk (merging from the game's originals) uses `realFs`/`realStat`.

- The view is filled synchronously from the staging manifests when the extension starts, before
  the extensions that read game folders at startup (it loads right after `mod_management`).
  Running programs of the game follow every change to the view, a ghosted plugin included.
- LOOT already runs libloot in a worker (`ELECTRON_RUN_AS_NODE`) started through `runExecutable`.
  The worker is started with `vfsGameId`, a run option that puts any program in the game's
  session, so libloot reads the composed `Data` folder.
- A deploy, purge or view change updates the sessions of programs still running
  (`Session.setRoot` swaps a root's provider live), so the long-lived LOOT worker follows later
  deploys. A target outside the game folder that did not exist when a program started reaches
  programs started later. Session folders of ended Vortex processes are removed at startup.
- Native readers: `exe-version` and the plugin header parser are TypeScript over `fs`, and
  ARCtool merging reads the game's originals and staging. Programs an extension spawns itself
  see the real disk, so BG3's divine and QuickBMS are given `util.realFilePath(path)`: the
  staged (or written) file behind a deployed path, the path itself otherwise.
- Programs Vortex starts get tool variables expanded before a runner takes them, a runner's
  failure never falls back to an elevated start outside the session, and "Close Vortex" on
  start becomes "hide" for a virtually deployed game (its session lives in Vortex). FNIS and
  the Witcher 3 script merger name their game, so they run in its session wherever they are.
  7 Days to Die's custom user data folder, which Steam's launcher passes, is passed on the
  command line of a direct start. A Steam launch option a game's launcher asks for
  (`parameters: ["option2"]`) is honoured too: its program and arguments come from Steam's
  cache, `appcache/appinfo.vdf` (`util/steamAppInfo.ts`), so Halo MCC starts
  `mcc-win64-shipping.exe -no-eac` in the session instead of the EAC launcher.
- Known gaps, each outside what per-launch injection can reach:
    - Epic games that insist on starting through the Epic launcher are started by it, not by
      Vortex, so they never enter the session.
    - "Open folder" opens the real folder, which does not show the mods. Explorer windows are
      created by an existing Explorer or a DCOM server, not by a process Vortex starts; even
      `explorer.exe /separate` started in the session hands the window to that server.

### 4. Linux: a FUSE mount

Implemented in `vfs_deployment/mounts.ts` on aether-vfs's `vfs-fuse`. Each virtually deployed
game's roots are mounted at their locations (unprivileged, through `fusermount3`) by a mount
helper (`mountHelper.ts`): Vortex's own Electron run as Node, detached, so the mount outlives
Vortex as links did and Steam's own Play button keeps seeing the mods. There is one helper per
game folder for the user, in `~/.local/state/vortex/vfs-mounts/<game>-<folder hash>`, whichever
Vortex profile or package deployed last (a folder has one mount, as it had one set of links); a
starting Vortex takes over a folder another profile mounted, and replaces a helper that loaded
another install's addon. Vortex and the helper talk through files there: Vortex writes
`spec.json` (the session to
serve); the helper mounts it, swaps a new deployment of the same folders in place, remounts
other folders, reports `status.json` (touched every two seconds, so a dead helper's status goes
stale) and logs to `helper.log`. The helper runs Vortex's own Electron as Node, and loads the
addon beside it; an AppImage starts it through `$APPIMAGE`, whose own mount lasts as long as the
helper (Vortex's ends with Vortex), and a Vortex of another version replaces a running helper,
whose native addon cannot be swapped. While a folder is mounted, an autostart entry
(`~/.config/autostart/vortex-vfs-<game>-<hash>.desktop`) starts its helper again at login, so
the mods are there after a restart, as links were; unmounting removes it. Removing the spec unmounts and ends the helper. A deploy
unmounts first and waits for the helper to end, so the deployment reads the game's own files,
then mounts the result; a purge unmounts. Vortex's support check needs `/dev/fuse` and
`fusermount3` (package `fuse3`). Ubuntu's AppArmor profile for `fusermount3` only mounts under
`$HOME`, `/mnt`, `/media`, `/tmp` and `/run/user`, whatever the package: a game elsewhere needs
a local rule (`/etc/apparmor.d/local/fusermount3`).

A Flatpak Vortex has no `/dev/fuse`: aether-vfs then mounts through `$FUSERMOUNT_PATH`, a
wrapper that runs aether-vfs's `fusermount-relay` on the host (`flatpak-spawn --host`, at the
host path of the app's files that `/.flatpak-info` gives). The relay gives the host's
`fusermount3` a socket of its own and passes the FUSE device back over the socket the sandbox
forwarded: Ubuntu's profile refuses a socket from inside bubblewrap (`file_inherit`, peer
`bwrap`), so forwarding the sandbox's socket straight to `fusermount3` fails there. The
helper is started with `flatpak-spawn`, in a new sandbox of the app that does not end with
Vortex, and its login entry runs `flatpak run --command=...`. Verified with the
`vfs-nightly-20261024.9` Flatpak installed on Ubuntu 26.04: from inside the sandbox the helper
mounted through the bundled relay, the host saw the mod, the mount stayed with no Vortex
sandbox running, a program's new file landed in the write folder, ending the helper and running
the login entry's command mounted again, and removing the spec unmounted.

An AppImage's GUI does not start on Ubuntu 24.04 and later (Chromium's sandbox, see the Linux
packaging guide). Its mount helper needs no GUI: started through `$APPIMAGE` from the
`vfs-nightly-20261024.9` AppImage, it ran in its own mount of the image, loaded the addon beside
its program, served a mod over a folder's own files, and removing the spec unmounted the folder
and ended the helper and its image mount.

Verified on Ubuntu 26.04 with the `vfs-nightly-20261024.7` tar.gz and the real Stardew Valley
install (a Windows game under Steam's Proton, Steam installed as a Snap): the method was chosen
by itself; a deploy served a mod's replaced title texture through the mount; Vortex exited and
the mount stayed; ending the helper as a logout does unmounted, and running the login entry's
command mounted again; Steam's own launch (`steam://rungameid`, Vortex closed) started the game,
whose mount namespace (`/proc/<pid>/root`) served the mod's texture; a purge unmounted and
removed the login entry, and the game folder was unchanged. `mounts.test.ts` runs the real
helper with a fake addon.

The original plan follows.

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

Implemented: a 32-bit game gets the 32-bit shim and injector from `assets/aether-vfs/x86`, and
Vortex's support check accepts it when they are installed. Verified with aether-vfs's 32-bit
fixture launched from a 64-bit session, and with the real 32-bit `SysWOW64\cmd.exe`, `xcopy` and
`robocopy` reading and copying a served mod file by name and by wildcard. Verified with a real
32-bit game, Fallout: New Vegas (Steam, Ultimate Edition) and Gopher's Stable New Vegas
(collection `60wuix`, revision 17): the FNV 4GB Patcher, run from Vortex, writes the patched
`FalloutNV.exe` and its backup to the write folder, leaving the game's own unchanged; started from
Vortex, `nvse_loader.exe` starts the patched game, which loads xNVSE and its plugins (JIP LN,
JohnnyGuitar, Engine Optimizations) and the collection's plugins through the session and reaches
its main menu. Vanilla New Vegas does not start on that machine with or without the virtual file
system; the collection's engine fixes are what let it run.

Steam's DRM wrapper is never bypassed. The game's own wrapper runs unchanged and checks ownership
with Steam as when Steam starts it (Steam records the game process for its app id). A
32-bit wrapper whose header the injector cannot read (New Vegas's) is not touched at all: the shim
goes in by remote injection instead of the in-memory import patch, which edits the image's import
directory in memory. `steam_appid.txt` and `SteamAppId` only tell Steam which game a directly
started executable is, as script-extender loaders do. The plan:

aether-vfs gains an x86 build: `vfs-ntlayout` with 32-bit layouts, the shim and its hooks, and
`vfs-injector32.exe`. A 64-bit Vortex launches a 32-bit game through the 32-bit injector; the ring
is fixed-width, so the same director serves both (asserted at compile time on both targets).

## Games verified

Each with a disposable copy of the Steam install, a popular collection or the mods named, started
from Vortex (Windows, 2026-10-24):

| Game               | Collection                                        | What it exercised                                                                                                  |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Skyrim SE          | probe mods                                        | plugins, BSAs and meshes served; LOOT; 64-bit SteamStub                                                            |
| Fallout: New Vegas | Gopher's Stable New Vegas (`60wuix`)              | 32-bit SteamStub, xNVSE's loader starting the game, 4GB Patcher writing into the write folder                      |
| Stardew Valley     | Stardew Valley VERY Expanded (`tckf0m`, 101 mods) | SMAPI found as a tool through the view, 58 mods and 64 content packs, a .NET mod mapping its own DLL               |
| Valheim            | Valhiem Expanded 2025 (`y738ki`, 86 mods)         | a downloaded game extension, BepInEx's doorstop proxy, 77 plugins, its log in the write folder                     |
| Oblivion           | Through The Valleys (`a5pbuu`, 106 mods)          | xOBSE downloaded by the script extender's Fix, `obse_loader` injecting the 32-bit game, OBSE plugins from the view |
| 7 Days to Die      | Jeebie's 7Days+ (`kfn2nc`)                        | a mods folder outside the game folder (the User Data Folder), passed as `-UserDataFolder`                          |
| Palworld           | Palworld Better Experience (`rpy5tv`, 35 mods)    | a downloaded game extension, the launcher starting the shipping exe, UE4SS's proxy DLL with C++ and Lua mods       |

On Linux (Ubuntu VM, Snap Steam, Proton): Stardew Valley with the `vfs-nightly-20261024.13`
tar.gz, as described under "Linux: a FUSE mount".

What these found and fixed: tools a mod provides were not discovered (the walk view gave
discovery walks the real disk only); a flush of a view of a served file failed (.NET's
`MemoryMappedViewAccessor.Dispose`); 32-bit SteamStub and child injection by the shim's virtual
path; on Linux, a purge as the game activated left it mounted.

Not caused by the virtual file system, and the same with links: vanilla New Vegas and Oblivion do
not start on that machine (Oblivion crashes on start without mods too); game extensions create
their mod folders in the game folder when the game is activated (Valheim's `BepInEx\plugins`,
Palworld's `ue4ss\Mods`), so those empty folders appear there; an extension that purges during
its own setup, before the game has a deployment method, reports "No deployment method currently
available" once (Palworld).

## Packaging

`src/main/copy-assets.mjs` installs aether-vfs into `assets/aether-vfs` (unpacked from the
asar): the Node binding and the shim (Windows) or the relay (Linux), downloaded from a pinned release of doodlum/aether-vfs
(`vortex-<sha>`, published by its `vortex-artifacts` workflow for every push to a `vortex-*`
branch) and checked against pinned SHA-256 sums. To move to a newer aether-vfs, pin that
release's tag and the sums from its `SHA256SUMS-*.txt`; a program's `mode` makes it executable. `VORTEX_AETHER_VFS_DIR` makes a
development build load a local aether-vfs build instead.

The fork's `aether-vfs-nightly.yml` keeps this branch merged with `linux` and publishes
`vfs-nightly-*` pre-releases.

## Migration

Implemented through the existing method checks on game activation (`onGameModeActivated`): the
virtual method `supersedes` the link methods, so a game on one of them, where the virtual
method is supported, has its link deployment purged with that method (originals restored from
`.vortex_backup`, the game folder's manifest removed), switches to `aether_vfs`, is marked for
deployment and gets a "Deployment method upgraded" notice. Downgrading is safe: an older Vortex
does not know `aether_vfs`, finds a clean game folder and deploys with its default link method,
leaving the setting as it was. When this version starts again, a virtual game whose folder holds
a link deployment of this install has it purged the same way (`purgeLinksLeftBehind`); the file
view steps aside meanwhile (`setAside`), so the purge acts on the real links and not on the
view's files. Verified on Windows with the sandbox game (given a real x64 `game.exe`, which the
virtual method requires): released Vortex 2.8.0 deployed a mod over a game file with hard links
in a profile it created; this branch purged them, restored the file, switched and deployed
virtually; 2.8.0 then deployed with hard links again; this branch purged those on its next start
and deployed virtually, once. Tests: `mod_management/eventHandlers.vfsMigration.test.ts`.

The original plan follows. A core migration runs once, when this version first starts:

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
