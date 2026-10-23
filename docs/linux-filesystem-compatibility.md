# Linux compatibility draft

This branch integrates Linux changes on upstream master. It is under verification;
passing scoped unit tests does not establish application or Windows/Linux deployment parity.
The original `local/linux-support` branch is retained unchanged for comparison.

## Filesystem boundaries

Deployment comparison folds paths for Windows executables running on Linux. Native games
keep the target filesystem's comparison rules. FOMOD callbacks accept Windows separators
and resolve archive spelling at their boundary. Executable discovery applies case lookup
to Windows tools and games; native executable paths keep their case.

Case lookup prefers an exact existing spelling, accepts one unambiguous folded match,
and rejects ambiguous matches. Vortex internal filesystem imports retain host paths.
The game-owned extension boundary below also translates legacy filesystem arguments.
For case-insensitive game targets, deployment keeps the spelling already on disk, then
uses the previous manifest or a base backup for missing outputs. New shared directories
receive one spelling in sorted path order. This rule applies on both Windows and Linux,
so switching conflict winners preserves the same physical destination names. It changes
Windows' incidental filename recasing during conflict replacement; file contents and mod
priority still determine the winner. Native case-sensitive games keep separate names.

The manifest's `relPath` identifies the destination. Optional `sourceRelPath` records a
different spelling inside the source mod. Older records use `relPath` for both. External
change import/delete, link removal and move placeholders retain the staging spelling.
Ambiguous existing case variants are refused when no exact component matches; no directory
tree is globally rewritten. Only touched directories are listed and cached per deployment.

Legacy duplicate-case records remain owned until removed. Disabling a source removes all
of its matching variants while retaining other sources. Cleanup finishes every unlink in
one folded path group before restoring any base backups; a remaining variant keeps those
backups parked through relinking. Distinct physical Linux backups are restored separately.
Case-only updates, delayed Windows alias removal, partial disable and move placeholders
have regression cases. Run the Linux cases on a case-sensitive filesystem.

## Choosing a staging folder

When game mods and Vortex user data are on different filesystems, Linux suggests staging
under the highest writable folder on the mods' filesystem, outside the game directory.
Existing symlinks are resolved before finding the filesystem and excluding the physical
game directory. Missing trailing mod directories are retained while resolving their nearest
existing ancestor. Permission errors and symlink loops are reported rather than treated as
missing folders. If no writable folder on that filesystem exists outside the game, the
suggestion fails with setup guidance. This also applies when the game occupies the entire
mount. Windows continues to use its existing drive-root suggestion.

From `src/renderer`, run:

```sh
pnpm exec vitest run src/extensions/gamemode_management/util/discovery.stagingVolume.test.ts src/extensions/mod_management/views/Settings.suggest.test.ts
```

The real cross-filesystem symlink fixture needs an ordinary Linux user, writable `/dev/shm`
on a different device from the temporary directory, and symlink support. It skips when that
second filesystem is unavailable; a skipped fixture does not verify this boundary. The
other fixtures cover read-only mount points, missing directories, error propagation and the
Windows control. No game, account or display is needed. Verify the actual suggested path
and staging/deployment separately in the application.

## Staging scans during installation

A staging scan can overlap an install, cancellation or reinstall. Reconciliation
checks the captured records against current game records after reading the disk.
An internal cancellation is not an external deletion, and an installation registered
while the scan waits is not an unknown directory. Installing or downloading records
are excluded from removal warnings. Delayed confirmations preserve records replaced
or created while the prompt was open.

Genuinely unknown directories and missing settled mods still require the existing
**Mods changed on disk** confirmation. Empty or unavailable staging roots retain their
existing protections. The harness must not dismiss that confirmation to hide an
internal-install race.

From the src/renderer directory, run:

```sh
pnpm exec vitest run src/extensions/mod_management/util/refreshMods.test.ts src/extensions/mod_management/util/dropMissingMods.test.ts
```

These inert tests need no game, account, native runtime or display. They change Redux
state while the filesystem scan or confirmation is pending, retain genuine external
change controls and test the existing missing/empty root behavior. Run `pnpm run verify`
from the repository root, then exercise a real app cancellation followed by a new attended
install, with no false external-change prompt. Keep a unit result separate from that
real workflow result.

## Existing game extensions and user folders

On Linux, the public game setup, primary/secondary mod-path and folder-detail callbacks
run with their explicit game and installation. At an extension's filesystem boundary,
legacy Documents, Roaming, Local and LocalLow paths are translated to that Windows
game's initialized Steam prefix. This also handles strings cached when an extension
module loaded. The public `getVortexPath` API continues to return host roots; Vortex's
own caches and resources keep their host locations.

The boundary covers Vortex API filesystem methods and registered extensions' CommonJS
imports of `fs`, `node:fs`, `fs/promises`, `node:fs/promises` and `fs-extra`.
It translates filesystem path arguments and declared game path results, including both
copy/rename paths. File contents, options and file descriptors retain their values.
An already-resolved prefix path stays stable even when the Steam library is below host
Documents. Translated filesystem arguments retain a final directory separator, and
fd-backed streams leave their ignored path alone. Executable selectors read metadata
without recursively applying the game filesystem boundary.
Native Linux games and Windows hosts retain their original filesystem behavior.
Asynchronous setup callbacks preserve their game context even when using a shared
Bluebird promise. A single-game extension's later event/UI filesystem calls use its
registered game and current discovery. Multi-game and generic extensions need an
explicit game callback or `getGameUserPath(gameId, discovery, role, subpath)`.

Core Gamebryo plugin management is bundled statically, so it calls
`getGameUserPath(gameId, discovery, "localAppData", folder)` itself: `plugins.txt`,
`loadorder.txt`, their profile copies and LOOT's local data use the Windows game's prefix
(`AppData/Local/<game>`), with physical case lookup. LOOT requirement and incompatibility
file names are Windows-relative and resolved with `resolveCasePath` below the data folder.
Windows and native games keep `LOCALAPPDATA` and the store-specific folder names.

This boundary does not infer ownership before a game is registered, translate arbitrary
file contents or rewrite command-line arguments. Eager module-load reads, Windows paths
serialized inside manifests and game-specific configuration still need an appropriate
consumer implementation. Direct ESM filesystem imports and unknown filesystem packages
are outside this CommonJS loader boundary. Missing Steam identity or an uninitialized
prefix produces setup guidance; it must not cause a Windows game to write host folders.

From `src/renderer`, after building workspace dependencies, run:

```sh
pnpm exec vitest run src/util/extensionRequire.gamePaths.test.ts src/util/getGameUserPath.test.ts
pnpm exec vitest run --config ./vitest.integration.config.mts tests/gameUserConsumers.test.ts
```

Run these checks on Windows and case-sensitive Linux with the pinned source toolchain.
They use disposable host folders and initialized prefix fixtures, without a game, Steam
process, account or desktop. Actual bundled Sims 3 and Dragon Age setup/query callbacks,
native Torchlight, shared asynchronous callbacks, module aliases, filesystem clones and
streams exercise ownership and host-file preservation. Passing these checks establishes
those filesystem contracts; actual games and packaged application checks remain separate.

## Proton panel and execution

The Proton page is registered on Linux and visible for the active profile's discovered
Steam game when the store snapshot identifies it as using Proton. Before the first
Steam scan, no matching entry is available. Launch the game in Steam once to initialise
its prefix, then rescan games if necessary.

The version picker selects one installed Proton version for Steam and Vortex. The default,
**Proton Experimental (recommended)**, is Steam's own default for Windows games. When it
is missing, Vortex asks Steam to install it (`steam://install/1493710`) and finishes
setting up the game once the download completes; **Retry setup** continues it sooner. A
specific choice stays with the profile. The default never downgrades a prefix: when a
newer Proton built the game's prefix, Vortex uses an installed Proton that can drive it as
it is (the one Steam already uses, otherwise the one that built the prefix) and points
Steam at it, which also repairs a game an earlier build had moved to an older release.

You can still pick an older Proton, as in Steam. Proton downgrades a prefix only when it
starts a program, which Steam does at game launch, while Protontricks drives Wine directly
and an older Wine against a newer prefix can hang. Before installing Windows components,
Vortex therefore starts a no-op command with the selected Proton, letting Proton remove its
newer files exactly as a game launch would; saves and settings in the prefix are kept. If
the prefix is still newer afterwards, setup stops with an explanation. GE-style versions
cannot be ordered and are not checked. To apply Steam compatibility and launch settings, start Steam with
`-cef-enable-debugging` and keep it running. Vortex uses the local settings endpoint
at port 8080; an unavailable service gives setup guidance. An unavailable selected runtime
produces an error rather than silently launching another runtime. Tools outside the game
directory use their associated game's identity, not a string prefix of their tool path.

Proton launches receive the selected Steam app ID and game prefix, with the same app
context Steam passes to a game (`SteamAppId`, `SteamGameId`, `SteamOverlayGameId`,
`STEAM_COMPAT_APP_ID` and `STEAM_COMPAT_INSTALL_PATH`), so a context inherited from
another game cannot leak in. The native Steam
bridge also needs the SDK links that Steam creates on first startup. For Snap Steam,
Vortex selects the matching Steam home for the Proton child process by checking the
SDK library identity. Vortex keeps its own home, and an explicit tool HOME override
remains in effect. Start Steam once and initialise the game prefix before using tools.
Proton launches use the same cancellation, error notification, exit recording and
hide-and-recover window handling as ordinary executable launches.

A Windows executable is never passed directly to Linux after an unavailable or
failed Steam scan. Missing game identity, ambiguous app IDs and a native-build
Steam entry produce an explanatory launch error. Refresh Games after Steam
changes, and initialise the selected Windows/Proton build once in Steam.
StarterInfo passes its explicit Vortex `gameId` through `runExecutable` options.
The shared API honors a registered interpreter first; otherwise it uses that game
context, or the executable/explicit working directory when no game id is supplied. A registered interpreter can rewrite the command
to a Linux executable; a hook or interpreter which leaves a raw `.exe` cannot
fall through to the system binfmt handler. Native Linux and Windows-host
launches retain the existing spawn, exit and window lifecycle.

Installed Proton discovery scans the client and configured libraries, checks for the
`proton` launcher, and supports custom compatibility tools. Missing libraries do not
prevent scanning others. Per-game and default settings take precedence over the installed
fallback, which prefers Experimental, then the numerically newest official stable version.

The original Proton header, compatibility card, mod requirements, shader cache controls
and local feedback footer are restored from `local/linux-support`. Required-component
installation is enabled by default per profile. Turn it off to manage dependencies yourself.
The manual **Install requirements** button asks for confirmation. Automatic setup runs on
profile/deployment changes and before matching Windows launches; it serializes work and
rechecks the selected profile before starting each external command or writing success.
An already-started installer cannot be undone by switching profiles.

Detection reads up to eight MiB from each enabled installed mod's `.exe`/`.dll`, recursing
up to eight levels. These byte signatures are hints, not proof of a redistributable
requirement. Installation and verification use Winetricks records, because runtime DLLs
can be Wine built-ins. A changed Proton prefix version reapplies the detected recipes.
No detected recipes means no dependency-helper preparation. Initialize the game in Steam
first; Vortex does not guess another game's prefix.

Managed recipes need Flatpak and a Flathub remote on the Steam host, network access for
vendor redistributables, and an initialized prefix. Vortex uses an existing
`com.github.Matoking.protontricks` installation, preferring the per-user one. Otherwise it
installs it per user, or system-wide when Flathub is only a system remote (as on Bazzite
and Fedora Atomic; a system install may ask for authorization). It updates that
installation and invokes it with the exact Steam
client, App ID, initialized prefix and selected Proton metadata name. Custom tools use
their internal compatibility-tool key. Duplicate or mismatched installations are refused.
Both manual and automatic setup use this same serialized preparation. A one-shot sandbox
grant makes the selected prefix writable and the required client/library/runtime roots
readable. The exact required Steam Runtime also receives writable access to its own
`var` cache and existing deployment `.ref` lock files, which pressure-vessel needs.
Inherited Wine executable overrides are cleared; the final Protontricks runtime and
prefix are checked before any recipe executes. Recipes run unattended and their
installation records are checked afterward. From a Vortex Flatpak setup uses
`flatpak-spawn --host`. Each helper step is capped at 30 minutes and each recipe run at
20 minutes; a run that stops responding is ended (SIGTERM, then SIGKILL after ten
seconds) and reported as a setup error, so it cannot block later launches.
Installation progress appears in Vortex's notification center and continues there when
you leave the Proton page. The activity stays open while Vortex verifies installation
records and the prefix version; completion is reported only after those checks pass.
Failures leave one error notification and a setup alert with **Retry setup** above the
page. The page follows Health Check's layout: bordered sections with small neutral
actions, settings and statuses on raised rows, and Vortex's shared `Alert`, `Pill`,
`Switch`, `Picker`, `Field`, `Toolbar` and `NoResults` components. Requirement pills
use neutral text with a coloured icon. Without Steam or a Proton game the page shows
an empty state instead of the settings. A refresh keeps the last result on screen
until the same installation has been read again.
Native Flatpak dependency commands and Flatpak host commands preserve literal quoted
arguments and environment values without invoking a shell.

Install Flatpak using your distribution's package manager and, if no Flathub remote
exists yet, add the user remote with:

```sh
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
```

**Protect Steam's shader cache** keeps a private per-game cache under
`~/.cache/vortex/shadercache/<appid>`. Vortex ships the Python launcher in its application
bundle and provisions it under `~/.local/share/vortex/bin`; no manually supplied script is
needed. Python 3.10 or newer is required in the launch environment and on the Steam host.
The helper checks its configuration before Vortex enables protection. Flatpak also checks
execution on the Steam host from `/`, since its packaged `/app/main` directory is not
available outside the sandbox. Steam launches use
a managed launch-option wrapper; Vortex's direct Proton commands invoke the same helper.
From Vortex Flatpak, direct Proton commands execute on the host with the selected game's
environment and working directory, so the game can connect to the host Steam client.
The local Flatpak portal process starts from the host root; sandbox-only environment variables are
not forwarded. Proton, Wine, DXVK, VKD3D, MangoHud, Gamescope and GPU-driver tuning
variables that you set before starting Vortex (for example `PROTON_LOG=1` or
`DXVK_HUD=fps`) are forwarded, as a native Vortex passes them on; the selected game's
prefix and Steam identity always take precedence. Arguments and environment values retain literal quotes without invoking a shell.
Spawn callbacks identify the portal proxy; its exit status reports host signals as 128 plus
the signal number. This route has been exercised with Steam installed through Snap;
a Steam client inside its own Flatpak still needs separate runtime validation.
Existing custom launch options are preserved. A detected Windows default-primary loader
is redirected only for Steam game launches; separately selected tools keep their executable.
Steam settings reads and writes require the connected client's root library and game
installation to match the selected physical paths. Vortex validates both and rechecks
them on the same connection before applying a change; unavailable or mismatched clients
produce an error. Start the matching Steam client and refresh Games before retrying.
Reads use a one-shot native app-details subscription so they reflect current launch
options even when Steam’s library page has no active observer; the library store’s
cached details can otherwise keep returning an earlier value after a successful write.

The private cache starts from the first nonempty configured Steam cache, excluding its
`downloads` directory. The helper hashes source bytes and reseeds after a source change.
The helper marks its child environment as prepared for Steam (`SteamEnv=1`) after
setting the private cache paths. This prevents the native Steam bridge from replacing
them when a Windows game starts outside a Steam launch session. The marker applies
only to protected helper launches; it does not change the running Steam client.
When no cache paths are inherited, defaults retain Steam’s seeded directory layout.
The **Private copy** row compares actual private/source bytes, showing Steam-copy and
added/changed sizes and file counts, and **Matches Steam** when nothing has changed. An
unavailable source is not reported as an identical copy. **Reset cache** stays disabled
until Vortex has read the game's Steam launch settings, because only those say whether the
private copy or Steam's own cache is in use. It confirms first, refuses while tools are running, and replaces only a
marked Vortex-owned private cache. Steam downloads, precompiled source databases, mods
and game files stay intact. With protection disabled, reset removes only the recognized
generated cache files. The helper refuses links/special files inside cache trees,
unowned private directories, overlapping paths and concurrent resets. Source library
aliases are resolved; private-cache ancestors must not be symlinks. Atomic replacement
requires Linux `renameat2` support. A refusal is reported rather than deleting other data.

From `src/renderer`, with Python 3.10+ available on Linux, run:

```sh
pnpm exec vitest run src/extensions/proton_management src/util/Steam.test.ts src/util/linux/proton.test.ts src/util/linux/protonMetadata.test.ts src/util/StarterInfo.test.ts src/ExtensionManager.proton.test.ts
```

The Linux launcher test runs disposable real-file and child-process fixtures, including
copy/update/reset preservation, links, overlap, literal arguments/environment, signals and
busy locks. Windows runs the portable management/launch controls and skips Linux-only
filesystem/process fixtures. These tests need no account, game, Steam process or network.
They do not establish vendor downloads, actual Steam settings acceptance, GPU cache
behavior or packaged sandbox support; exercise those workflows separately in the app.
Run the repository's full `pnpm run verify` with development sessions stopped before
publication. Record source, packaged runtime and real-game evidence separately.

### Credits

The prefix-downgrade check, recipe timeouts, Flatpak tuning-variable forwarding, the
system-wide Protontricks fallback and the extra Steam app-context variables are adapted
from [Amethyst Mod Manager](https://github.com/ChrisDKN/Amethyst-Mod-Manager) by ChrisDKN
(GPL-3.0, commit `544d0055eab0916fbf65b9adabe761ddd3fff06a`): `src/Utils/wine/protontricks.py`,
`src/Utils/flatpak/env.py`, `src/Utils/flatpak/i386.py` and
`src/Utils/executables/launch.py`. Vortex is also GPL-3.0; the source comments name each
origin.

## Native dependencies

Use the pinned dependencies in `pnpm-workspace.yaml`. Current master's node-loot dependency
already provides Linux build settings and Unix socket transport. The old branch's copied
native binaries and staging helper are not used. Verify the packaged runtime on Linux;
Windows build output cannot be copied into the Linux checkout.

Basic/XML FOMODs use `@nexusmods/fomod-installer-native` on both platforms, as
upstream does. Legacy C# scripts select the IPC backend: Windows retains its .NET
Desktop Runtime helper; Linux x64 runs the helper's .NET Framework 4.8 build under
a bundled native Mono, prepared automatically. Ordinary Linux builds need no system
Mono or .NET SDK. See the [legacy C# runtime guide](legacy-csharp-runtime.md) for
display prerequisites, consent, cache handling and compatibility limits. Basic/XML
checks do not establish C# installation or deployment support.

## Selected upstream work

These are source references, not claims of upstream acceptance or final verification.
Changes are adapted to master's current store snapshots and asynchronous manifest parsing.

| PR                                                       | Area                                   | Local adaptation                                                                                  |
| -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [24602](https://github.com/Nexus-Mods/Vortex/pull/24602) | Windows-game deployment case conflicts | Keep native game comparison; cover duplicate-case records and same-mod spelling updates.          |
| [24392](https://github.com/Nexus-Mods/Vortex/pull/24392) | Proton process tracking                | Add host PID namespace handling and exact-path checks.                                            |
| [24389](https://github.com/Nexus-Mods/Vortex/pull/24389) | External tools use game prefix         | Match the associated game directory exactly.                                                      |
| [24286](https://github.com/Nexus-Mods/Vortex/pull/24286) | Prefix Documents                       | Propagate unresolved Steam lookup/prefix errors instead of using host Documents.                  |
| [23828](https://github.com/Nexus-Mods/Vortex/pull/23828) | Default Proton and multiple libraries  | Repair absent configuration, Experimental paths, missing libraries and numeric version selection. |
| [24379](https://github.com/Nexus-Mods/Vortex/pull/24379) | Store process detection                | Preserve master store APIs.                                                                       |
| [24380](https://github.com/Nexus-Mods/Vortex/pull/24380) | Dashboard disk space                   | Use portable disk information.                                                                    |
| [24381](https://github.com/Nexus-Mods/Vortex/pull/24381) | Start on login                         | Linux XDG autostart entry.                                                                        |
| [23831](https://github.com/Nexus-Mods/Vortex/pull/23831) | nxm URLs in an existing instance       | Pass URLs through Linux command handling.                                                         |
| [24477](https://github.com/Nexus-Mods/Vortex/pull/24477) | Staging paths with trailing separators | Normalise paths used for link targets and ownership comparisons.                                  |

[24557](https://github.com/Nexus-Mods/Vortex/pull/24557), the INI fallback patch, is closed
unmerged. Maintainer feedback rejects patching that dependency and favours replacement.
It is not imported here. Bundled consumers instead use the new workspace
[@nexusmods/ini-parser](../packages/ini-parser/README.md): Windows keeps its native
backend, while Linux uses lossless file deltas. INI baking no longer silently skips
Linux. Tweak matching folds names while opening the original physical source path.
Documents-based INI baking and FOMOD reads use the associated Steam Windows game's
initialized Proton prefix. Bundled Gamebryo settings/save paths, local profile settings,
Witcher settings and Sims options use the same explicit per-game resolver.
The SMAPI Log action resolves the selected Stardew build: Proton logs come from its
prefix, native logs keep host AppData and case-sensitive filename selection. Complete
filenames pass through the same per-game resolver as their containing folders. Missing Proton identity produces setup guidance
before reading any host log. Missing installation discovery also requires selecting
the game on the Games page; a default native executable is not enough to associate
a host log with an installation. Bethesda settings/application-data folder buttons resolve
the current discovery each time, including after a Steam library/prefix change; their
Windows store-specific folder names remain in effect.
Flight Simulator resolves its AppData and configured Windows packages path through its own
prefix; existing physical spelling is retained. Native Linux games, Windows, and files inside the game
directory keep their existing locations. Missing Steam identity or prefix is reported
before writing host Documents. Initialize the Windows game in Steam and refresh
discovery. A Windows game from another store (Heroic, Lutris, Bottles or plain Wine)
uses the Wine prefix whose `drive_c` contains its installation: the nearest such
ancestor with a `system.reg`, and that prefix's `steamuser` account or, failing that,
the account named after the current Linux user. A Steam game never falls back to a
containing Wine prefix, and a game outside any prefix still fails with setup guidance.
Launching such a game still requires Steam; Vortex does not run a raw Windows executable.
The package documents encodings, native comparison fixtures, consumer run commands
and runtime limits. From `src/renderer`, `pnpm run test:integration` checks real bundled
settings writers against disposable prefixes and host sentinels, using a supplied
Steam snapshot with no game, Wine process, account or desktop. These fixtures do not
establish game compatibility. Native app verification remains required for this draft.

## Verification commands

Install dependencies with the repository's pinned pnpm and Node versions. Build workspace
dependencies before direct renderer checks; `pnpm nx run @vortex/renderer:typecheck` follows
that dependency graph. From `src/renderer`, run:

```sh
pnpm exec vitest run src/util/linux src/extensions/gamemode_management/util/ProcessMonitor.test.ts src/extensions/mod_management/LinkingDeployment.test.ts src/extensions/mod_management/LinkingDeployment.caseInsensitive.test.ts src/util/Steam.test.ts src/util/StarterInfo.test.ts src/ExtensionManager.proton.test.ts src/util/gameLaunchAnalytics.test.ts
```

From `extensions/local-gamesettings`, run `pnpm exec vitest run` for profile-copy and prefix
Documents regression checks. Linux-only case tests skip on Windows and must pass in the VM.
The extension API tests compose public StarterInfo with the actual ExtensionManager,
mocking the Node process boundary and unrelated extension/download setup. They cover
registered interpreters with both valid and unavailable Steam identity.
The lifecycle tests mock the process boundary while exercising public launch state,
analytics callbacks and hide/close/recover modes. These checks prove individual contracts only. Final validation also needs full `pnpm run verify`,
a native app launch, visible Proton page checks, and matching deployment fixtures on both OSes.
Do not run builds against an app's currently running checkout.

### Real filesystem deployment comparison

The deployment parity fixture uses temporary game and staging directories. It needs no
Nexus login or purchased game. Run it on both Windows and a case-sensitive Linux filesystem
with the same repository revision, pinned Node/pnpm versions and installed build dependencies.
On Windows, file symlink creation must be permitted; an `EPERM` failure is an unmet host
prerequisite, not a passing or equivalent symlink result.

From `src/renderer`, on Linux:

```sh
VORTEX_DEPLOYMENT_PARITY_REPORT=/tmp/linux-deployment-parity.json pnpm exec vitest run src/extensions/mod_management/LinkingDeployment.parity.test.ts
pnpm exec vitest run src/extensions/mod_management/util/canonicalDeployment.test.ts src/extensions/mod_management/util/externalChanges.test.ts
pnpm exec vitest run src/extensions/hardlink_activator/nativeHardlinks
```

From the same directory in PowerShell:

```powershell
$env:VORTEX_DEPLOYMENT_PARITY_REPORT = "$env:TEMP/windows-deployment-parity.json"
pnpm exec vitest run src/extensions/mod_management/LinkingDeployment.parity.test.ts
pnpm exec vitest run src/extensions/hardlink_activator/nativeHardlinks
Remove-Item Env:VORTEX_DEPLOYMENT_PARITY_REPORT
```

The parity fixture runs the real hardlink, symlink and move deployment methods through
conflicts, disable/re-enable and purge. It checks winner bytes, base backups, unrelated
files and preservation of staged sources. It also checks native `Foo`/`foo` on Linux.
The optional JSON contains completed cases only; first require a successful, complete
test run on each OS. Compare hashes and manifest ownership for each matching method.
Its report normalises separators while preserving case, so matching reports cover physical
filename spelling for these fixtures. They do not establish
archive extraction, Nexus collection installation or all game workflows.

Outside Windows, the hardlink activator's support check links its canary from the staging
folder into the game's deployment folder, the same link deployment makes. Bind mounts share
the game's device number yet refuse links across them with `EXDEV`. A Flatpak's own data
folder (`~/.var/app/<id>`, which holds the default staging folder) is such a mount even with
host filesystem access. `EXDEV` reports the existing same-drive reason, so Vortex chooses
another supported method (normally symlinks) or offers moving the staging folder, instead
of selecting hardlinks that deploy nothing. Windows keeps its canary inside the staging folder.
Run `pnpm exec vitest run src/extensions/hardlink_activator/isSupported.test.ts` from
`src/renderer` on both OSes; its mocked `EXDEV` covers the decision, not a real Flatpak.

The native hardlink purge reads bigint device/inode pairs directly because turbowalk's
POSIX fallback omits link counts and file IDs. It removes only regular files linked to
the configured staging directory, skips directory symlinks, includes hidden files and
waits for each bounded batch to finish before reporting failure. Native helper tests cover
unrelated hardlinks, device identity, large inode precision, disappearing files and pending
operations during failure. Directory-symlink fixtures run on POSIX; they skip on Windows.

Linux Steam setup awaits its initial store scan before synchronous game support
callbacks resolve prefix folders. It then validates the associated initialized
prefix; a failed or missing identity still requires the Steam setup described
above. Windows and native Linux game setup retain their previous ordering.

The INI consumer integration target also checks mixed-case Flight Simulator
config/Community folders and a physically present Oblivion custom font. Relative
Windows filenames below a resolved root use `util.resolveCasePath` through the
final filename. The INI package guide includes the deliberately pending scan and
FOMOD selected-file regression command and explains its prerequisites and scope.

## Unsigned Linux package

From the repository root, run `pnpm package:nosign` with the source-build prerequisites
below installed. This builds production bundles, prepares `src/main/dist` and produces
the Linux zip and unpacked application in the repository-root `dist/`. It does not sign
or publish a release.

The Linux packager copies the prepared dependency tree into a private directory below
`/var/tmp`. The pinned collector otherwise traverses parent checkouts and can collect
the same native binding twice, failing with `EEXIST`. Scratch storage needs room for
one additional copy of the prepared tree. Set `VORTEX_LINUX_PACKAGE_TMPDIR` to another
existing disk directory if needed; neither it nor its ancestors may contain
`node_modules`. Dependency symlinks must stay inside the prepared tree. Original
deployment inputs remain available throughout packaging. Successful runs remove their
private copy; failed runs print and retain its path for diagnosis. Inspect that path
before removing failed inputs.

After packaging, from the repository root run:

```sh
node scripts/verify-packaged-asar.mjs --asar dist/linux-unpacked/resources/app.asar
```

This compares nested dependency versions against the prepared tree. It does not prove
native addon loading: launch the unpacked application and exercise attended FOMOD
installation, cancellation and renderer reload against that packaged runtime. The
source app and pure native backend checks are separate evidence.

From `src/main`, `pnpm exec vitest run package-nosign.test.ts` checks isolated payloads,
resource/output paths, dependency-link boundaries, retained failures and cleanup without
building an app or signing anything. Run it on both hosts; the link cases require POSIX
and skip on Windows. The Windows unsigned command keeps its existing deployment path.

If the unpacked executable aborts with a Chromium SUID sandbox helper diagnostic,
configure that trusted build's exact helper from the repository root:

```sh
sudo chown root:root -- dist/linux-unpacked/chrome-sandbox
sudo chmod 4755 -- dist/linux-unpacked/chrome-sandbox
```

Recheck this after unpacking or rebuilding, then launch as the ordinary desktop user.
Keep sandboxing enabled. The helper setup is separate from the asar/native-library
checks; Playwright's Electron launch alone does not establish ordinary executable
bootstrap. Verify cold, warm and reset bootstrap with the packaged executable too.

## Native FOMOD backend

Basic and XML installers use Vortex's unchanged `installer_fomod_native` extension
and the `@nexusmods/fomod-installer-native` package, built from the
[doodlum/fomod-installer](https://github.com/doodlum/fomod-installer) `linux` branch.
That build keeps upstream's code and adds a safe bridge lifecycle: queued callback
arguments are owned by the bridge, closing cancels pending dialog work, managed
completion is joined before its handler is freed and no JavaScript runs after a
Worker stops. Its NativeAOT library stays mapped for the process lifetime. Without
this, reloading the renderer after a completed install crashed Vortex on Linux.
The same package serves Windows and Linux, so both run identical installer code.
The pnpm catalog installs `@nexusmods/fomod-installer-native` and `-ipc` from that
repository's GitHub pre-release tarballs, with lockfile integrity hashes; `allowBuilds`
names the native tarball URL so its install script runs. Those fork builds are unsigned.
The native addon target is `mi`, which keeps node-gyp's Windows intermediate paths
within `MAX_PATH` under pnpm's hashed store directory for URL dependencies.

The installer's file callbacks resolve archive members under their archived spelling,
so Windows separators and case in installer XML find files on a case-sensitive
filesystem. Installer images use `resolveCasePath` below the extracted archive.

Real-app checks install an attended XML FOMOD, choose a non-default option, deploy,
purge and reload the renderer; cancel one wizard and run the next; and reload while
a wizard waits. Run them on both hosts and compare the staged/deployed/purged files:

```sh
VORTEX_FOMOD_PARITY_REPORT=/tmp/fomod-physical.json pnpm exec playwright test --config <fomod real-app config>
```

Matching reports cover these fixtures' physical output only, not every installer.

### Legacy C# discovery and consent

For Oblivion, Fallout 3 and Fallout: New Vegas, as upstream, the legacy installer
recognizes an archive member named `fomod/script.cs`, including wrapper
directories, mixed case and Windows separators. Recognition reads only the archive entry list; it neither starts a helper
nor compiles or evaluates the script. All archive members remain available to
the installer because a C# script may request any asset in the package. Absolute
paths, parent traversal, drive syntax and NUL bytes reject this installer claim.

The C# install entry point owns the existing per-game mod allowlist and unsafe
script confirmation. A script outside that allowlist requires an explicit
`Install anyway (unsafe)` response before deployment synchronization, runtime
checks or helper initialization. Cancel, dismissal or a missing dialog capability
stops installation. Simulation, stored choices and unattended callers use this
same entry point; sandbox trust metadata does not suppress confirmation.
Basic/XML and explicit file-list copies do not execute the C# route.

From `src/renderer`, run:

```sh
pnpm exec vitest run src/extensions/installer_fomod_ipc/tester.test.ts src/extensions/installer_fomod_ipc/installer.trust.test.ts
```

These account-free tests need only the normal JavaScript workspace dependencies.
They cover discovery and consent wiring with an inert helper boundary; no mod
script executes. Run them on Windows and case-sensitive Linux. They do not prove
native C# execution, real dialog interaction, physical deployment or packaging.
The native runtime/cache, platform routing and startup contracts have additional
inert tests described in [the C# runtime guide](legacy-csharp-runtime.md). Actual
packaged installation and deployment parity remain separate verification gates.
