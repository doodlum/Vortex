# Linux filesystem and extension compatibility

## Symptoms

- A game can be detected but fail to enter game mode when an extension uses the
  wrong letter case for an executable path.
- Deployment can be reported as unsupported when a game extension declares a
  deployment directory that has not been created yet.
- Older external extensions can fail to load modules such as `bluebird`,
  `string-template`, or `winapi-bindings`, even though those dependencies are
  bundled with Vortex.

These failures are more visible on Linux because its native filesystems are
case-sensitive and because external extensions are stored outside the packaged
application archive.

## Root causes and fixes

1. Game extensions must use the exact on-disk case of executable paths. The
   Dark Souls II extension now uses `Game/DarkSoulsII.exe`.
2. Before deployment methods test a declared mod-type target, Vortex now creates
   that target directory. This prevents a missing but creatable directory from
   being mistaken for an unwritable filesystem and applies to every game and
   deployment method.
3. The external-extension loader now resolves shared dependencies from Vortex's
   packaged `app.asar` before falling back to an extension's own `node_modules`.
   This retains extension-local dependency overrides while restoring support for
   legacy extensions that relied on Vortex-provided modules.

No game DLL is replaced by these fixes. Deployment continues to use the
original game and mod files through the selected deployment method.

## Filesystem policy

Vortex should expose one canonical user-data tree and one canonical game path.
Compatibility links may point to that tree, but they must not create independent
copies. Directory creation, path-case validation, and dependency resolution are
therefore handled centrally rather than by copying files into individual game
or plugin folders.
