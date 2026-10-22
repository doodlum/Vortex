# Fedora Setup

Install the distro packages here first, then continue with [Shared Setup].

Validated on 13 April 2026 (Fedora 43). If any step is out of date, please open
a [PR] or [issue].

## Refresh Package Metadata

Refresh package lists so install uses latest repo data.

```bash
sudo dnf makecache --refresh
```

## Install Dependencies

```bash
# Install dependencies.
sudo dnf group install development-tools
sudo dnf install git python3 python3-setuptools gcc g++ fontconfig-devel
```

The native Linux installer runtime is bundled. A system .NET SDK or Mono is not
a prerequisite for normal builds; see [legacy C# runtime details](../legacy-csharp-runtime.md).

## Verify Install

```bash
python3 --version
gcc --version
```

## Continue Setup

After the packages above are installed, continue with [Shared Setup].

## Extra Related Resources

- [Fedora package search]

[Fedora package search]: https://packages.fedoraproject.org/
[Shared Setup]: ./shared.md
[PR]: https://github.com/Nexus-Mods/Vortex/compare
[issue]: https://github.com/Nexus-Mods/Vortex/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=
