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

The version picker stores a profile override for launches made by Vortex. It does not
rewrite Steam's compatibility choice or launch options. An unavailable selected runtime
produces an error rather than silently launching another runtime. Tools outside the game
directory use their associated game's identity, not a string prefix of their tool path.

Proton launches receive the selected Steam app ID and game prefix. The native Steam
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

The panel shows winetricks records, runtime file indicators and hints from enabled mod
executables. File indicators can be Wine built-ins; byte hints are not proof of a required
redistributable. Follow the mod's instructions and use Protontricks explicitly when needed.
Profile changes and deployment do not install helpers or modify global Steam settings.
The incomplete prototype shader-cache and dependency reconciliation was removed.

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
discovery; automatic Windows-game Documents mapping currently requires Steam.
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
