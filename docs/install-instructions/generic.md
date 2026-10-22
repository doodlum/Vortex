# Generic Installation Instructions

This page covers distro-specific prerequisites before [Shared Setup].

## Installer runtime

Normal Linux builds use the bundled native C# runtime and need no system .NET SDK
or Mono installation. See [the runtime guide](../legacy-csharp-runtime.md) for its
x64/glibc requirements. Windows and optional maintainer builds of .NET projects
still use [.NET 9 SDK].

## Python And C/C++ Toolchain

Vortex depends on native Node modules which require [node-gyp]. You need a
[supported Python version] and a C/C++ toolchain.

### Windows

Use [Windows setup] for full Windows prerequisites.

### Linux

Install `make` and `gcc`. Common package names are `build-essential` on Debian
and Ubuntu, and `base-devel` on Arch Linux.

### Python 3.12+

Starting with Python 3.12 you also need `setuptools`. Verify your version with
`python3 --version`, then install the package through `pip` or your system
package manager.

## Next Step

After these prerequisites are installed, continue with [Shared Setup].

## Notes

- For NixOS, use [NixOS Setup] instead of [Shared Setup]

[.NET 9 SDK]: https://dotnet.microsoft.com/en-us/download/dotnet/9.0
[node-gyp]: https://github.com/nodejs/node-gyp
[NixOS Setup]: ./nixos.md
[Shared Setup]: ./shared.md
[Windows setup]: ./windows.md
[supported Python version]: https://devguide.python.org/versions/
