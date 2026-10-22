# Debian-based Setup

Install distro packages here first, then continue with [Shared Setup].

Validated on 13 April 2026. Verified on Ubuntu 24.04 and Pop!\_OS 24.04.
If any step is out of date, please open a [PR] or [issue].

## System Packages

### Refresh Package Metadata

Refresh package lists so install uses latest repo data.

```bash
sudo apt update
```

### Install Dependencies

```bash
sudo apt install build-essential git python3 python3-setuptools curl wget libfontconfig-dev
```

The Linux branch bundles its legacy C# runtime. Do not add a Microsoft package
feed or install a .NET SDK/Mono for the normal build. See [the runtime guide](../legacy-csharp-runtime.md)
for platform requirements and the separate maintainer rebuild operation.

## Verify Install

```bash
python3 --version
gcc --version
```

## Continue Setup

After the packages above are installed, continue with [Shared Setup].

## Extra Resources

- [Debian package tracker]

[Shared Setup]: ./shared.md
[Debian package tracker]: https://tracker.debian.org/
[PR]: https://github.com/Nexus-Mods/Vortex/compare
[issue]: https://github.com/Nexus-Mods/Vortex/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=
