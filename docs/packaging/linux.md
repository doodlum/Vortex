# Linux Distribution Packages

Build Linux packages from one prepared Vortex payload with `pnpm package:linux`.
This is a development packaging workflow. Generation and payload checks are
separate from distro installation, game integration and release approval.
The current bundled legacy C# runtime targets Linux x64 with glibc2.35 or newer;
see [its runtime requirements](../legacy-csharp-runtime.md).

## Prepare the application

Use Linux x64 and the repository's pinned Node/pnpm toolchain and normal source
build prerequisites. Keep the checkout and application idle during packaging.
From the repository root:

```sh
pnpm package:nosign
node scripts/verify-packaged-asar.mjs --asar dist/linux-unpacked/resources/app.asar
```

This builds production bundles, prepares `src/main/dist`, and creates
`dist/linux-unpacked` plus the existing configured ZIP. The application package under the configured `directories.app`
(`src/main/dist/build/package.json`) must match the unpacked application's name
and version; the deployment root package is still the `@vortex/main` workspace. The packager checks that
match before generating formats and repeats the nested dependency version check.

Unsigned preparation isolates dependency collection from ancestor node_modules
trees. Its scratch directory needs room for another prepared tree; see
[unsigned packaging prerequisites](../linux-filesystem-compatibility.md#unsigned-linux-package).

## Install packaging tools

The tools are build-machine prerequisites. Application users do not need Ruby,
RubyGems, Node, pnpm or a .NET SDK to run the resulting packages.

| Formats          | Additional build tools                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| DEB, RPM, Arch   | Ruby and RubyGems; normal format tools such as tar, xz and gzip                       |
| RPM              | rpmbuild                                                                              |
| Snap             | snap CLI with its packing support                                                     |
| Flatpak          | flatpak, flatpak-builder, AppStream tools, Flathub user remote and the runtimes below |
| AppImage, tar.gz | The prepared deployment's pinned electron-builder/app-builder tools                   |

For Flatpak, install the user-level build/runtime inputs once:

```sh
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08
```

The common-payload route uses the compiled application and its bundled native
legacy C# helper. It needs no Node or .NET SDK extension inside Flatpak. The older
[source-based Flatpak workflow](flatpak.md) has a separate incomplete pnpm migration.

Native formats automatically prepare a private FPM1.18.0 tool cache from
`scripts/linux-fpm-lock.json`. Every gem's version and SHA256 are pinned; all
archives are verified before an offline, dependency-resolution-free RubyGems
installation. No system gem directory is modified. The completed cache is
published atomically and its installed files, archives, Ruby/RubyGems executable
hashes and reported versions, and FPM version
are checked before reuse. An inconsistent cache fails with its path for inspection.
The pinned electron-builder's older bundled FPM fails with modern RPM build roots,
so the driver uses this private tool for DEB, RPM and Arch.

Allow disk space for a common snapshot and temporary package copies. The driver
places TMPDIR below its unique output run, avoiding per-user tmpfs quotas on /tmp.
The input and output/tool-cache trees must be separate. A first run may download
the pinned gems and app-builder's packaging tools; Flatpak runtimes are installed
explicitly above. This command is not an offline-build guarantee.

## Generate formats

After preparing the application, generate all seven formats:

```sh
pnpm package:linux
```

Select a subset or use distinct names for development installs:

```sh
pnpm package:linux --formats deb,rpm,pacman,AppImage,tar.gz
pnpm package:linux --formats snap,flatpak --snap-name vortex-linux-port --flatpak-app-id com.nexusmods.vortex.Development --flatpak-branch linux-port
```

The default Flatpak ID is `com.nexusmods.vortex`. Use `--flatpak-app-id` with a
separate reverse-DNS application ID for development installs that coexist with
another Vortex installation. The selected ID is applied to the Flatpak manifest,
desktop entry, window identity, icon, AppStream metadata and bundle reference;
the application payload stays common. The ID starts with a letter. Subsequent
components start with a letter or underscore; component bodies contain letters,
digits or underscores, with hyphens also allowed in the final component. At least
three components are required. This packager supports up to 177 ASCII characters,
leaving room for Vortex's generated protocol alias and atomic temporary filenames
on filesystems with 255-byte filename components. This is a supported subset of
Flatpak's broader name grammar. Paths, whitespace and shell syntax are refused.

The desktop Background portal selects startup applications by ID. A different
branch of the same ID does not provide isolated permissions or startup selection.
Use a distinct ID when testing startup alongside another installation; see the
[desktop integration procedure](../linux-desktop-integration.md#automatic-startup).
`result.json` records the selected ID, branch and Snap name under `packageIdentity`.

Run `node scripts/package-linux.mjs --help` for input, deployment, output and
tool-cache paths. Generation currently executes on Linux x64. Each run gets a
new directory under `dist/linux-packages`; previous failures and their logs are
retained. `result.json` records pipeline/configuration/prepared-metadata hashes, the common
input identity, primary packaging tool executable hashes/versions and artifact hashes.
It does not capture every operating-system/library input or promise byte-reproducible
archives;
`payload-manifest.json` records the snapshot's files, executable flags and symlinks.
The driver verifies that both the original input and common snapshot remain
unchanged. Internal absolute symlinks are relocated inside the snapshot.

The command creates DEB, RPM, Arch .pkg.tar.xz, AppImage, Snap, Flatpak and tar.gz
files. It does not install, sign or publish them. Snap metadata uses classic
confinement because mod management needs host access. Local installation requires
explicit `--dangerous --classic` approval; store publication requires its own
confinement review. Its grade remains devel.

Flatpak uses Electron2.BaseApp/Zypak and exports its desktop entry. Its filesystem,
network, graphics/audio and host-command permissions are part of the manifest;
inspect them before installation. Debug splitting and stripping are disabled so
the module preserves the common binaries; the driver compares its installed app
tree before bundling and records the installed runtime commits.

The Flatpak declares `--allow=multiarch` for its bundled static i386 QuickBMS
helper. The host kernel must support 32-bit x86 execution; this static helper
needs no 32-bit shared-library extension. See
[Flatpak's multiarch guide](https://docs.flatpak.org/en/latest/multiarch.html).
After installing a generated bundle, check its permissions and native helper:

```sh
flatpak info --show-permissions com.nexusmods.vortex
flatpak run --command=/app/main/resources/app.asar.unpacked/bundledPlugins/quickbms-support/quickbms_4gb_files com.nexusmods.vortex -h
```

Substitute the selected development application ID when applicable. Expect the
multiarch feature and QuickBMS help output. This checks sandboxed 32-bit execution;
archive transformations, the Vortex UI and game consumers need separate checks.

AppImage uses the pinned app-builder assembler with an explicit desktop entry and
standard AppRun. The generic electron-builder AppImage target adds --no-sandbox
by default, so this driver supplies the launcher directly. Both AppImage and Snap
forward arguments unchanged, including raw nxm URLs, without disabling Chromium
sandboxing. Actual sandbox availability remains a target-system prerequisite.

DEB, RPM and Arch packages install `chrome-sandbox` root-owned with mode 4755.
An AppImage cannot (its FUSE mount is nosuid), and an extracted tar.gz or
`dist/linux-unpacked` keeps a user-owned helper, so these rely on Chromium's
user-namespace sandbox. Hosts that restrict unprivileged user namespaces, such as
Ubuntu 24.04 and later (`kernel.apparmor_restrict_unprivileged_userns = 1`), abort
these launches with a "SUID sandbox helper binary was found, but is not configured
correctly" FATAL (SIGTRAP) until an AppArmor profile grants `userns` to that
executable or the helper is made root-owned 4755 where it can be. Recommend the
native package, Snap or Flatpak there. The nightly AppImage was observed to abort
this way on an Ubuntu 26.04 VM.

## Verify the artifacts

Run the isolated packager regression suites from `src/main` on Windows and Linux:

```sh
pnpm exec vitest run package-nosign.test.ts package-linux.test.ts
```

These use disposable files and inert subprocesses. They cover snapshot containment,
source independence, pinned-download rejection, Flatpak ID validation and exported
metadata consistency, argument forwarding and Linux tool
process cleanup; they do not install packages or launch Vortex. Linux-only symlink,
shell and process-group controls are skipped on Windows. Real generation and the
packaged-asar check are separate gates.

For every generated format, inspect identity, architecture, dependencies, license,
desktop entry, icons and install/removal hooks. Compare the actual extracted app
files with `payload-manifest.json`; format-specific launchers/metadata are separate.
Then test install, upgrade and removal in a disposable system for that distro.
Launch as an ordinary desktop user with a separate profile and sandboxing enabled.
Check native addons, FOMOD install/deploy/purge, nxm routing, autostart, game
discovery and Proton management/game launch where applicable. Desktop identity,
portable integration and container host-launch routing still need their own checks.

All formats currently target x64; musl and other architectures are unverified.
An extracted RPM/Arch comparison on Ubuntu does not establish runtime support on
their native distributions. The full submission gate is `pnpm run verify`; it
excludes E2E and cannot replace the per-format checks above.

## Fork nightlies

`.github/workflows/linux-port-nightly.yml` runs only outside `Nexus-Mods/Vortex`.
Schedules and manual dispatch use the copy on the fork's default branch, so keep
that copy identical to the one on `linux`. Each run merges upstream `master` into
`linux`, builds the unsigned Windows installer, the DEB, RPM, Arch, AppImage and
tar.gz packages, and Snap and Flatpak in separate jobs that are allowed to fail and
upload their retained packaging logs when they do, then publishes the packages as a
`nightly-*` pre-release and keeps the newest seven. A merge conflict stops the run;
resolve it on `linux` by hand. `GITHUB_TOKEN` cannot push merges that change
workflow files: add a `LINUX_SYNC_TOKEN` secret with contents and workflows write
access to push those, otherwise each build job re-applies the merge unpushed.
These builds are unsigned and are not official Nexus Mods releases.
