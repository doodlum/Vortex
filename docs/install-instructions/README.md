# Installing from Source

Building Vortex from a clone. Pick the page for your platform, install the
prerequisites it lists, then finish with [shared.md](shared.md), which covers
the repository bootstrap common to all of them.

[CONTRIBUTING.md](../../CONTRIBUTING.md) is the shorter route if you already
have a working toolchain.

## Prerequisites by platform

- [windows.md](windows.md) - Windows 11, from PowerShell or Command Prompt
- [archlinux.md](archlinux.md) - Arch and derivatives
- [debian-based.md](debian-based.md) - Debian, Ubuntu, Pop!\_OS
- [fedora.md](fedora.md) - Fedora
- [nixos.md](nixos.md) - NixOS, via the repo `flake.nix`
- [generic.md](generic.md) - What the prerequisites are, for a distro without a
  page of its own

## Then

- [shared.md](shared.md) - Cloning, `pnpm install`, building and running

NixOS uses the [FHS launcher procedure](nixos.md) for install, build, tests and
startup. Its Nix tools bootstrap the repository-pinned pnpm and Node inside
that environment; optional direnv exposes the launcher.

Each platform page records the date and version it was last validated against.
If a step has gone stale, updating that line is part of fixing it.
