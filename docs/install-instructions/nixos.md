# NixOS Setup

The flake provides a Linux FHS development environment for the repository's
downloaded Node, Electron and native modules. `flake.lock` pins the system
libraries and bootstrap tools; `package.json` and `pnpm-workspace.yaml` retain
ownership of the application runtime versions. There is no system Electron
override or ordinary-build .NET SDK requirement.

## Requirements

- Nix with `nix-command` and `flakes` enabled, and access to its binary cache.
- A graphical Linux session for Vortex; X11 or Xwayland for legacy C# dialogs.
- Unprivileged user namespaces usable by bubblewrap and Chromium. A restrictive
  AppArmor policy can prevent startup even when dependency evaluation succeeds.
- Several gigabytes of free space for the Nix closure, plus workspace dependencies
  and build output. The first shell invocation downloads its dependencies.

This environment is for development. Successful evaluation or an Ubuntu FHS
probe does not certify native NixOS installation, distro packages, every game or
every legacy installer.

## Install, build and start

Clone with submodules as described in [Shared Setup], then run these commands
from the repository root:

```sh
nix run . -- pnpm install
nix run . -- pnpm run build
nix run . -- pnpm -C src/main exec electron . --disable-setuid-sandbox
```

The first `pnpm` comes from Nix and bootstraps the repository's pinned pnpm and
Node. Native binaries execute inside the FHS environment, where their normal
ELF interpreter and shared-library paths exist. Keep install, build, tests and
application processes inside that environment; adding Nix libraries to a host
shell's `PATH` alone is insufficient.

`--disable-setuid-sandbox` selects Chromium's namespace sandbox because a setuid
helper cannot provide its usual privileges inside the rootless FHS namespace.
Chromium still needs a usable namespace sandbox. Do not add `--no-sandbox` to
work around a launch failure.

For an interactive FHS shell:

```sh
nix develop
pnpm exec node --version
exit
```

For automation, use `nix run . -- <command> <args>` as above. The default
development shell enters its FHS shell through a shell hook; use the app entry
point when command arguments must be forwarded.

## Optional direnv and VS Code

With [nix-direnv] installed, `direnv allow` loads `.envrc` and exposes the
`vortex-dev` launcher. It does not move your terminal or editor into an FHS
namespace. Prefix repository commands explicitly:

```sh
direnv allow
vortex-dev pnpm exec node --version
vortex-dev pnpm run build
```

Start VS Code with this launcher on its `PATH`, or use the [VS Code direnv
extension], then choose **Debug Electron (Nix FHS)**. That profile enters the
FHS environment before starting the workspace Electron and uses the namespace
sandbox. The existing debug profiles remain available for other environments.
Git GUI hooks also need to execute their `pnpm` commands inside `vortex-dev`;
having the launcher on `PATH` does not wrap arbitrary commands automatically.

## Check the environment

```sh
nix flake check --no-build
nix run . -- pnpm --version
nix run . -- pnpm exec node --version
nix run . -- env ELECTRON_RUN_AS_NODE=1 pnpm -C src/main exec electron -p process.versions.electron
nix run . -- pnpm run verify
```

Compare Node and pnpm with `package.json`, and Electron with the workspace
catalog. Bootstrap tool versions can differ from those repository pins. Stop
Vortex before `verify`, which rewrites application build output. The suite
excludes E2E and does not establish graphical startup or a complete installer
workflow. Changes to this flake also need actual native-addon compilation,
sandboxed Electron rendering and bundled Mono dialog checks; see the
[legacy runtime guide]. A DejaVu font fallback keeps Forms usable when the FHS
root shadows the host's `/usr/share/fonts` directory.

## Troubleshooting

If bubblewrap reports `setting up uid map: Permission denied`, or Electron
reports `No usable sandbox`, inspect the host's namespace/AppArmor policy. On
Ubuntu, a policy for `/usr/bin/bwrap` does not automatically cover a Nix store
binary. Arrange a host-specific reviewed allowance for the required developer
process; the flake does not install one or change global kernel settings.

If downloaded Node reports a missing ELF interpreter, run the command through
`nix run . --` or `vortex-dev`. If Electron or native addons have an ABI mismatch,
remove stale system Electron overrides and reinstall/rebuild the workspace
dependencies in the FHS environment. Do not substitute an unrelated Nix
Electron major version.

[Shared Setup]: ./shared.md
[legacy runtime guide]: ../legacy-csharp-runtime.md
[nix-direnv]: https://github.com/nix-community/nix-direnv
[VS Code direnv extension]: https://marketplace.visualstudio.com/items?itemName=mkhl.direnv
