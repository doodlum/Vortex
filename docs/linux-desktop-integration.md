# Linux Desktop Integration

Vortex accepts Nexus links from Linux desktop launchers and reconstructs arguments
when Electron forwards a request to an already running application. This guide
describes that command-line contract and the remaining installation-specific work.

## Nexus link arguments

Linux desktop entries can pass one raw `nxm://` URI to Vortex. Explicit
`-d`/`--download` and `-i`/`--install` options keep their original meaning; Vortex
does not insert another download flag before an explicit option's value. A
URI-shaped value supplied to another option remains that option's value.

For example, these argument forms select a download on Linux:

```text
vortex nxm://<game>/mods/<mod>/files/<file>
vortex --download nxm://<game>/mods/<mod>/files/<file>
```

Use `--install` when requesting the existing download-and-install behavior.
The examples show argument syntax; a real request still needs a valid visible
file, network access and any required account authorization.

## Cold and already running applications

Electron44 groups switches ahead of their values in `second-instance` events.
New Vortex processes send their original argument array and development/packaged
mode through Electron’s JSON `additionalData` channel. The running instance validates
that payload and parses the original order. A raw URI before `--profile` or
`--user-data` therefore keeps both the link and the option’s value.

For a launcher without this payload, Vortex reconstructs the grouped arguments
from the same Commander option declarations used to parse them. That fallback
cannot recover every order: a raw URI before a valued option is ambiguous. Put
valued options before the URI when invoking an older launcher. Boolean switches, such as `--start-minimized`, consume no
value. Inline options retain their own value. Development Electron's application
path is kept separate from option values using `process.defaultApp`.

Fallback reconstruction runs before adding Commander's executable/script prefix.
Each parse uses a fresh command object, so a forwarded request has its own options.
Windows additionally rejects some URI-before-value command lines in Electron
before Vortex starts; this change preserves that native check.
The same reconstruction serves Windows; raw-URI normalization remains Linux-only.

Internal `--run` helper and `--report` invocations are terminal operations: they
execute before the normal application's single-instance lock. This lets a running
Windows instance start its elevated helper and lets either platform send an
existing crash report. Ordinary secondary launches send their original arguments
with the lock request and exit before Crashpad, telemetry and UI initialization.

## Verification

From `src/main`, run this on Windows and Linux:

```sh
pnpm exec vitest run src/cli.test.ts src/main.startup.test.ts
```

The fixtures in `src/main/src/__fixtures__/protocolArguments.json` derive from
actual cold and `second-instance` events in the pinned Electron44.2.0 on both
hosts, for packaged and development runtimes. Paths are normalized and an inert
probe marker is removed. Tests exercise the real Vortex parser without launching
Vortex, making a download, reading an account or running a mod script. They cover
raw/short/long URL forms, install requests, boolean and value options, repeated
requests, inline options and literal URI-shaped option values. The additional handoff fixtures retain the
actual JSON payload, including raw-first Linux requests, the option terminator,
sender development mode and malformed-payload fallback.

The startup tests execute the actual main entry with inert Electron, filesystem,
process and reporting adapters. They cover contested helper/report requests,
ordinary primary and secondary startup, and the existing isolated-test bypass on
both platform branches. They do not open a UAC prompt, execute an elevated helper
or upload a crash report; verify actual elevation separately on Windows.

Parser tests do not establish browser-to-app routing. Real checks must also cover
the installed desktop entry, the selected default handler, initial launch and
single-instance handoff. Keep the distinction between parsed arguments and a
completed download/install.

## Installation-specific integration

The main process resolves the current installation before Electron becomes ready.
It sets the window desktop name without changing the executable, application name
or user-data directory. Resolution reads metadata only. If the installation cannot
be identified, Vortex still starts and logs an integration error; a request to
register links fails rather than selecting a guessed launcher.

| Installation         | Link launcher and desktop identity                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Native DEB/RPM/Arch  | The exported `vortex.desktop`, only when its executable resolves to the running Vortex                                                    |
| Snap                 | snapd's exported filename and stable `/snap/bin/<instance>[.<application>]` command; no revision-specific executable                      |
| Flatpak              | The running deployment's actual application ID, architecture, branch and user/system/named installation, matched against `/.flatpak-info` |
| AppImage             | The durable outer image, with an installation-specific hidden entry                                                                       |
| Archive folder       | The executable's canonical path, with an installation-specific hidden entry                                                               |
| Development Electron | The Electron executable plus the application directory, with a checkout-specific hidden entry                                             |

Flatpak uses its canonical desktop ID for its window and a separate, installation-specific
protocol alias so selecting a development branch does not accidentally launch the
stable branch. The current development Flatpak requires its declared host filesystem
and host-spawn permissions. This does not claim Flathub approval or a restricted
sandbox implementation. Overridden/build Flatpak deployments are not automatically
registered because their host relaunch would lose those overrides.

Enabling **Handle Nexus Links** delegates through the existing preload IPC to the
main process. Vortex writes only its own hidden entry, wrapper and cached icon for
non-installed launchers; it refuses unrelated files and file symlinks. The wrapper
preserves argument boundaries, removes browser-inherited `LD_PRELOAD` and
`LD_LIBRARY_PATH`, and retains only the existing development environment allowlist
needed by Nix. Package-owned entries must be enabled and declare one unquoted URI placeholder and the NXM MIME type. They are selected without rewriting them; a user
entry that shadows a different installation is rejected or receives a separate
archive identity. Desktop string escaping and Exec quoting are separate, including
literal percent signs.

The host needs `xdg-mime` (xdg-utils) and, for generated entries,
`update-desktop-database` (desktop-file-utils). Vortex uses `xdg-mime default` and `query default`; this avoids the installed xdg-settings parser losing quoted executable paths. A failed command or a default-handler
readback that does not select Vortex rejects registration. Disabling registration
does not create an entry or take over another manager's default. Linux deregistration
continues to leave shared associations under desktop/user control.

Link registration and automatic startup are separate operations. Enabling one
does not enable or verify the other.

Run the context, escaping and protocol filesystem contracts from `src/main` on both
hosts, and the renderer delegation tests from `src/renderer` with its unit config:

```sh
pnpm exec vitest run src/linuxDesktopContext.test.ts src/linuxDesktopFile.test.ts src/linuxProtocol.test.ts
pnpm exec vitest run --config vitest.config.mts src/util/protocolRegistration/linux/index.test.ts
```

The first command belongs to the main project; the second belongs to the renderer.
Linux-only file-symlink and shell-execution controls are explicitly skipped on
Windows. These contracts do not establish installed-package runtime behavior. On
Linux also validate a generated entry with `desktop-file-validate`, launch an inert
argument recorder with `gio launch` to check reserved characters, and exercise actual
Vortex registration plus desktop-to-running-app URI delivery in a disposable profile
and XDG directories. Preserve the person's NXM default and user data; do not use a
real mod URL as an argument test.

## Automatic startup

In **Settings → Interface**, **Run Vortex when my computer starts** requests
automatic startup. **Start Vortex in the background (Minimized)** supplies the existing minimized argument.
Both controls wait for the main process to confirm the change. On failure, Vortex
shows an error and refreshes the confirmed Linux state, including a partially
applied change. Another request cannot overlap the pending operation.

Native packages, Snap, AppImage, archive and development installations use an XDG
autostart entry under the installation context's configuration directory. Installed
packages use their durable command; portable and development copies share the
owned wrapper and icon used for Nexus links. This keeps checkout paths, spaces,
literal arguments and the existing environment allowlist intact. Replacing or
removing an unrelated startup entry or a file symlink is refused. Entries from the
previous Vortex writer can be migrated when their full template is recognized.
Distribution formats sharing the standard Vortex ID share one startup selection.

Flatpak requests startup through the desktop's Background portal on its own
session bus. Vortex does not write the host startup entry itself. Desktop consent
may be required. The request explains: "Start Vortex automatically when you log in".
Cancellation, denial, disconnection and a two-minute deadline
produce an error. Closing the requesting window cancels its pending request.
The JavaScript D-Bus client is bundled with Vortex; no system Node module, native
D-Bus addon, Mono or .NET installation is needed for this portal transport.

The portal identifies applications by Flatpak ID and cannot pin an installation,
origin or branch in its startup command. Enabling startup therefore requires one
installed application reference for that ID, matching the running architecture,
branch and installation. This is checked again after portal consent. Give development installations a
[separate application ID](packaging/linux.md#generate-formats) when retaining another branch or installation. A portal
success response is followed by startup-file and exact argument readback; an
unexpected generated command is reported instead of claimed as success. Entries
with extra startup conditions (such as OnlyShowIn or TryExec) are not confirmed
as enabled because Vortex cannot establish that those conditions will permit login startup.

From `src/main`, run the startup and shared desktop contracts on Windows and Linux:

```sh
pnpm exec vitest run src/linuxAutoStart.test.ts src/linuxBackgroundPortal.test.ts src/linuxBackgroundPortal.transport.test.ts src/linuxDesktopContext.test.ts src/linuxDesktopFile.test.ts src/linuxProtocol.test.ts
```

From `src/renderer`, run the Settings confirmation/error tests:

```sh
pnpm exec vitest run src/extensions/settings_interface/SettingsInterface.autoStart.test.tsx src/extensions/settings_interface/SettingsInterface.test.tsx
```

These tests use disposable files, inert portal responses and a Linux-only local
socket. They do not prove the installed desktop's permission dialog, generated
Flatpak entry, login startup or minimized window behavior. Validate those against
an actual package with a disposable profile and isolated startup configuration;
preserve existing startup files and permissions. Link registration tests and an
inert D-Bus service cannot substitute for that runtime evidence.

## Key Files

- `src/main/src/cli.ts` — declared options, Electron reconstruction and Linux URI normalization
- `src/main/src/main.ts` — initial command-line parsing
- `src/main/src/Application.ts` — forwarded second-instance parsing
- `src/main/src/linuxDesktopContext.ts` — package origin and durable desktop identity
- `src/main/src/linuxDesktopFile.ts` — Desktop Entry serialization and parsing
- `src/main/src/linuxProtocol.ts` — main-process NXM registration and confirmation
- `src/renderer/src/util/protocolRegistration/linux/` — renderer delegation to typed IPC
- `src/main/src/linuxIntegrationFiles.ts` — shared owned wrappers and filesystem helpers
- `src/main/src/linuxAutoStart.ts` — startup ownership, installation routing and readback
- `src/main/src/linuxBackgroundPortal.ts` — direct Background portal transport and cancellation
