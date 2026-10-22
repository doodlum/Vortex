# Arch Linux Setup

Install the distro packages here first, then continue with [Shared Setup].

Validated on 13 April 2026 (`CachyOS 26.03`). If any deps are missing please open
a [PR] or [issue].

## Refresh Package Databases

Refresh package lists so install uses latest repo data.

```bash
sudo pacman -Sy
```

## Install Dependencies

```bash
sudo pacman -S --needed base-devel git python python-setuptools
```

The native Linux installer runtime is bundled. A system .NET SDK or Mono is not
a prerequisite for normal builds; see [legacy C# runtime details](../legacy-csharp-runtime.md).

## Verify Install

```bash
python --version
gcc --version
```

## Continue Setup

After the packages above are installed, continue with [Shared Setup].

## Extra Resources

- [Arch package search]

[Arch package search]: https://archlinux.org/packages/
[Shared Setup]: ./shared.md
[PR]: https://github.com/Nexus-Mods/Vortex/compare
[issue]: https://github.com/Nexus-Mods/Vortex/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=
