# Agent Instructions

Project and coding documentation lives in [docs/](docs/README.md). This file
covers only how to operate in this repo as an agent: verification, and which doc
to load for a task. It deliberately duplicates nothing from `docs/`.

## Verification

`pnpm run verify` from the repo root.

Scope a single test with `pnpm exec vitest run <file>` from inside the project
directory that owns it (e.g. `cd src/renderer` first). `pnpm run test` runs the
whole suite via nx and cannot be scoped.

`verify` **excludes the E2E suite** (`@vortex/e2e`), which needs a packaged app
and a real game install. Passing it is not evidence that E2E passes, so say which
suite you ran. Run E2E only when asked.

**Don't run `verify` while a dev session is live** — its `build` step writes
production output into `src/main/build`, the directory the running app loads
from. That overwrites the CSS `tailwind:watch` owns (watch only re-emits on a
source change, so it never notices) and replaces the HMR renderer bundle,
leaving the app with broken styles and dead HMR until dev is restarted.

You know a dev session is live if you started `pnpm run dev` or the "Debug
Electron" profile yourself, or if the user has one running: they'll have said
so, or asked you to use the chrome-devtools MCP or watch logs, both of which
need a live app. If in any doubt, ask before running `verify`.

While a dev session is running, use checks that don't write there: `pnpm run
typecheck` and `pnpm run lint`, plus `pnpm exec vitest run <file>` from inside
the owning project directory for a single test. `pnpm run format` is safe. Save
`verify` for the end.

Formatting, import order and Tailwind class order are owned by oxfmt and oxlint.
Don't hand-fix them; let the formatter win.

## Committing

Don't commit, push, or open a PR unless asked. Leave changes in the working tree
for review. If you're on `master`, branch first.

## Tool use

- Anything committed to `scripts/` should be cross-platform Node.
- Never run the signed `pnpm package` locally; signing secrets are CI-only. See
  `docs/packaging/windows.md`.

## MCP servers

**chrome-devtools** attaches to a running Vortex on `127.0.0.1:9222`, so Vortex
has to be started with remote debugging first: `pnpm run dev`, or the VS Code
"Debug Electron" profile. Use it to inspect live renderer state rather than
adding temporary logging, which tends to get committed by accident.

**Linear**: don't create or transition issues unless asked.

## Game IDs

`GameId` is the numeric Nexus Mods id (e.g. 1303), `GameDomain` the nexus
domain slug (e.g. `stardewvalley`), and `VortexGameId` the id Vortex gives a
game internally (the extension's game id, or the domain for extension-less
games); all three are branded types in `src/shared/src/types/ids.ts`. They are
different concepts even where their values coincide, so don't interchange
them.

- Don't accept or produce raw `string`/`number` where a branded type applies. Brand at the boundary from data that genuinely is that kindand keep the brand flowing.
- Don't cast across brands (`GameDomain(someVortexGameId)`). A branded type says where the value came from; guessing the origin defeats it.
- Comparisons between different brands are a type error **on purpose**. When you hit one, it means "find the real join", not "cast it", the type checker is pointing at data you don't actually have.
- Don't write ad-hoc lookups over the games list for an id you already have a helper for; if a join is missing, add it next to the existing ones.

## Which doc to read

Read the doc for the area you're touching rather than the whole tree.
`docs/README.md` is the full index; this is the shortcut.

- Finding your way around the repo: `docs/repo-layout.md`
- Renderer, React, UI: `docs/frontend.md`
- Redux state, reducers, actions: `docs/state.md`
- Writing or fixing tests: `docs/testing.md`
- Debugging, logs, diagnostics: `docs/DEBUGGING-GUIDE.md`
- Collections, phased install: `docs/mod-management/collections.md`
- Deployment case/source-path changes require real filesystem parity plus external-change import/delete checks; keep native case-sensitive games distinct.
- Linux autostart changes: read `docs/linux-desktop-integration.md`. Run main linuxAutoStart/linuxBackgroundPortal/linuxBackgroundPortal.transport plus shared desktop contracts on both hosts, and renderer SettingsInterface.autoStart/SettingsInterface tests. Rebuild shared declarations before checking renderer consumers. Keep native/portable/Snap durable launchers, strict startup-file ownership, Flatpak direct sandbox portal identity, a nonempty default reason independent of main-process translation setup, exact generated-argument readback, cancellation/connection cleanup and pending/error UI state. Unit fixtures and private D-Bus services do not prove actual portal consent, package startup or login/minimized behavior. Use isolated Flatpak IDs for development when another reference is installed; do not modify the person's startup/permission state to obtain a passing test.
- Linux desktop identity/NXM changes: also run main linuxDesktopContext, linuxDesktopFile and linuxProtocol tests on both hosts, plus renderer protocolRegistration/linux/index.test.ts with vitest.config.mts. Preserve exact package origin, native/Snap installed entries, user overrides, literal argv and main-process error propagation. Generated-entry GIO controls, actual ordinary Vortex and installed-package tests remain separate; autostart/portal is not proven by NXM.
- Linux desktop/URI changes: read `docs/linux-desktop-integration.md`. Run `src/cli.test.ts` from `src/main` on Windows and Linux; retain real Electron cold/second-instance argv and additionalData controls, including raw URI before valued options on Linux and malformed/missing-payload fallback. Parser tests do not establish desktop registration, autostart or a completed network request. Keep the initial main and forwarded Application consumers covered.
- Linux, Proton and deployment parity: `docs/linux-filesystem-compatibility.md`
- INI backend or consumer changes: `packages/ini-parser/README.md`; run native Windows/portable fixtures and affected FOMOD/INI-baking contracts, preserving encoding and staged hardlinks. Run the renderer `test:integration` target for bundled settings writers and explicit per-game prefix paths; its supplied Steam snapshot is not a real-game launch proof.
- Installers, release pipeline: `docs/packaging/windows.md`
- The auto-updater: `docs/updater.md`
- Writing documentation: `docs/writing-documentation.md`
- Code style: `CODESTYLE.md`

- Native Linux C# runtime changes: read `docs/legacy-csharp-runtime.md`. The bundled Framework Mono/net48 helper is separate from the Windows Desktop Runtime helper and the native Basic/XML library. Run the bundle/cache, native launcher, platform strategy, consent/discovery and installer_dotnet platform tests on both hosts. Keep archive/manifest pins exact, preserve consent before preparation, and verify actual helper/package/dialog/deployment behavior separately; scoped tests do not prove the complete C# workflow.
- Shared game-path/loader changes: read `docs/linux-filesystem-compatibility.md`. Run `src/util/extensionRequire.gamePaths.test.ts`, `src/util/getGameUserPath.test.ts` and `tests/gameUserConsumers.test.ts` from the renderer with their unit/integration configs on Windows and case-sensitive Linux. Preserve host API roots, explicit game ownership, async context and native controls; do not translate payloads or guess an active game for generic extensions. CommonJS filesystem boundaries do not cover eager pre-registration I/O, serialized Windows paths or command arguments.
- Game user-folder/log consumer changes: run the renderer integration target on both hosts. Its real-file fixtures cover Proton SMAPI log selection, native Stardew, current-prefix folder actions, missing identity and Windows store overlays. Keep native/game-directory paths distinct and read the Linux filesystem guide for scope.

- Linux unsigned packaging: `src/main/package-nosign.mjs` isolates the prepared deployment from parent dependency trees. Read the Linux packaging procedure, run `package-nosign.test.ts` in `src/main` on both hosts, then unsigned packaging, the packaged asar check and real packaged native-installer/reload checks. Source-app results cannot establish packaged addon loading.

- Native FOMOD changes: Basic/XML uses `@nexusmods/fomod-installer-native` built from the doodlum/fomod-installer `linux` branch on both platforms; keep Vortex's `installer_fomod_native` extension as upstream. Read the native FOMOD section of `docs/linux-filesystem-compatibility.md`, then run real-app install/deploy/purge/reload, cancel and reload-while-waiting checks on both hosts and compare their physical reports.

- Linux Windows-tool launch routing: run `StarterInfo.test.ts`, `ExtensionManager.proton.test.ts` and Steam/Proton lifecycle tests in the renderer project. Missing or failed Steam identity must not fall through to a raw Windows executable. Preserve explicitly registered Linux interpreters and verify actual Proton game launch separately.

- Legacy C# discovery/consent changes: read the legacy C# section in `docs/linux-filesystem-compatibility.md`. Run `installer_fomod_ipc/tester.test.ts` and `installer_fomod_ipc/installer.trust.test.ts` from the renderer on both hosts. Keep discovery metadata-only, require affirmative consent at the execution entry point for simulation/unattended callers, and preserve the per-game allowlist. Inert helper tests do not establish native execution or packaged support.

- Staging reconciliation during installs: read the staging-scan section in `docs/linux-filesystem-compatibility.md`. Run `mod_management/util/refreshMods.test.ts` and `dropMissingMods.test.ts` in the renderer on both hosts, preserve genuine external-change controls and verify real cancellation/reuse without auto-answering **Mods changed on disk**. Fresh-state checks belong before prompting and before delayed confirmation mutates records.

- Development Flatpak identity: `package:linux --flatpak-app-id` applies a validated separate ID to all exported metadata and the bundle reference without changing the common app payload. Exercise default/custom ID and invalid-input controls in package-linux.test.ts on both hosts, then inspect an actual generated/installed ref. A branch alone does not isolate portal startup permissions; retain the exact running-ID/reference checks.
- Linux distribution packages: read `docs/packaging/linux.md` and the runtime guide. Run `package-nosign.test.ts` and `package-linux.test.ts` from `src/main` on both hosts; real generation and packaged runtime checks remain separate. Keep the application payload common across formats; distinguish artifact generation, physical payload comparison and actual distro install/runtime checks. Snap/Flatpak confinement, protocol/desktop integration and native build inputs need their own validation; do not disable Chromium sandboxing to make a package pass.

- Nix FHS development changes: read `docs/install-instructions/nixos.md`. Evaluate/build the locked flake; verify repository-pinned Node/pnpm/Electron, fresh native-addon compilation, namespace-sandboxed Electron rendering, and bundled Mono/helper/dialog behavior separately. `.envrc` exposes only the launcher; run workspace commands inside it. Preserve the workspace Electron ABI and distinguish bootstrap versions from runtime pins. Do not disable Chromium sandboxing or infer native NixOS/distro support from Ubuntu FHS probes. The Nix debugger profile must enter FHS before launching the workspace binary.

- Native QuickBMS changes: read `extensions/quickbms-support/README.md`. Build the extension, then run its tests and typecheck on Windows and Linux. Keep pinned archive/executable verification, literal argv, explicit x86 kernel requirements and target-aware cache inputs. The public API test uses the actual built extension and inert archives; verify packaged native binaries and real game consumers separately.

- Main startup/instance changes: read `docs/linux-desktop-integration.md`; run `src/main.startup.test.ts` and `src/cli.test.ts` from `src/main` on both hosts. Keep terminal report/helper handlers before the ordinary payload-aware lock and normal initialization after it. The actual-entry fixture uses inert imports; real Windows elevation and Electron secondary-instance handoff need separate checks.

- Flatpak native-helper changes: the common manifest needs multiarch for the pinned static i386 QuickBMS binary. Run `package-linux.test.ts` on both hosts and execute the helper inside an actual generated Flatpak; an unpacked binary test does not cover Flatpak's architecture filter. Read the Linux packaging guide for the command and host-kernel requirement.
