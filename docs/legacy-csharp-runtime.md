# Legacy C# installers on Linux

This branch retains `fomod/script.cs` installers. Linux x64 uses a bundled native
Framework Mono 6.14.1 runtime and a .NET Framework 4.8 build of the Nexus FOMOD
helper. It runs directly on Linux. A game's use of Proton does not change the
installer runtime. Basic and XML FOMODs use the native FOMOD library instead.

The native bundle targets glibc 2.35 or newer and needs an X11 display, or Xwayland
inside a Wayland desktop, for Windows Forms dialogs. It uses system fonts. Mono,
the C# compiler, GDI+ and the native graphics libraries are bundled; users do not
install system Mono, .NET 9, Wine or a compiler for this route. Ordinary Linux
source builds also skip the Windows Desktop Runtime probe. Rebuilding the
maintainer's C# helper is a separate operation that still uses a .NET SDK.

## Install a mod

1. Add the mod archive normally. Detection examines archive member names without
   starting the helper or compiling the script.
2. For scripts outside the existing per-game allowlist, review the unsafe-script
   confirmation. Only an affirmative response continues. C# scripts run with the
   user's access to the system; the Linux launcher does not provide Windows
   AppContainer isolation. Saved choices and unattended mode do not bypass this
   confirmation.
3. Vortex checks the pinned manifest and any existing runtime cache. When a cache
   must be created or rebuilt, it also checks the bundled archive before preparing
   the runtime below `<Vortex user-data>/fomod-csharp/<manifest-sha256>`. This is
   automatic and needs no administrator privileges or separate runtime download.
4. Complete any installer dialog, then enable and deploy the mod normally.

The runtime cache is checked before reuse. A damaged cache directory is retained
with an `.invalid-<id>` suffix and replaced automatically. A damaged manifest
stops preparation. A damaged application archive stops cache creation or repair;
an already verified cache can still be reused. Repair or reinstall that Vortex
build if preparation fails. Cache paths that are symbolic links are refused.

The bundled runtime does not provide arbitrary Windows native DLLs or make every
Windows API portable. Installer compatibility and resulting deployments require
their own verification. The current branch's packaged C# workflow remains under
verification; a successful helper handshake is not a complete installation test.

## Verify changes

Install the pinned JavaScript workspace dependencies. From `src/renderer`, run:

```sh
pnpm exec vitest run src/extensions/installer_fomod_ipc/tester.test.ts src/extensions/installer_fomod_ipc/installer.trust.test.ts src/extensions/installer_fomod_ipc/utils/BundledRuntime.test.ts src/extensions/installer_fomod_ipc/utils/NativeProcessLauncher.test.ts src/extensions/installer_fomod_ipc/utils/connectionStrategy.test.ts src/extensions/installer_dotnet/index.platform.test.ts
```

These checks need a writable temporary directory, with no account, game, .NET
SDK, native compiler or running Vortex. They test metadata discovery, consent
ordering, archive/cache integrity, automatic repair, native launch arguments and
Windows fallback preservation using inert boundaries. Run on Windows and Linux;
they do not execute a downloaded mod script or prove packaged support.

The PE resource and icon packages use the committed `divine.exe` as a read-only
binary fixture. They never run it and do not build a probe with .NET:

```sh
pnpm -F pe-resources test
pnpm -F icon-extract test
```

Their Windows system-executable checks remain Windows-only. On Linux, the
committed PE fixture verifies real resource parsing and the no-icon case.

Full verification still requires `pnpm run verify`, followed by unsigned
packaging, an asar check and real C# installation/dialog/deployment/purge checks
on both hosts. Keep script review, file visibility, runtime identity and physical
output comparisons separate. Never run hidden, removed or moderated test downloads.

## Bundle maintenance

The runtime is Framework Mono 6.14.1 with its compiler and private native libraries,
stored as content-addressed objects (objects/<sha256>) plus a manifest of paths,
modes, sizes and hashes. It lives on the mono-runtime branch of
[doodlum/fomod-installer](https://github.com/doodlum/fomod-installer). On Linux x64,
src/main/copy-assets.mjs downloads both files from a commit-pinned URL, checks their
SHA-256 and caches them under
ode_modules/.cache/fomod-csharp. The same hashes are
pinned in
ativeRuntimeBundle.ts, which verifies them again before preparing the
runtime; update the URL commit and both pins together.

The helper is the .NET Framework 4.8 build of the Nexus FOMOD IPC helper,
dist/mono in @nexusmods/fomod-installer-ipc, built from that repository's
linux branch (dotnet build -p:FomodMono=true). The build copies it to
ssets/fomod-csharp/helper; electron-builder unpacks the asset directory so Mono
can run it. Extraction uses Vortex's existing SevenZip dependency. Mono runs from the
verified private cache, with an explicit compiler path and native library search
path. Windows retains its existing IPC helper and automatic Desktop Runtime setup.

Native runtime rebuild inputs, corresponding source availability and third-party
notices must be reviewed before distributing a release. The branch is not a release
certification for Flatpak, NixOS, other CPU architectures or arbitrary legacy installers.
