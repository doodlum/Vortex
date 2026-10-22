# Windows Desktop Runtime probe

This executable checks the installed Windows .NET Desktop Runtime. Normal Linux
builds skip it and its Nx SDK-version input; Linux C# installers use the
[bundled Mono/helper runtime](../../docs/legacy-csharp-runtime.md).

## Usage on Windows

`dotnetprobe 9` checks for the required runtime version. Vortex's Windows startup
check and automatic runtime installation remain unchanged.

## Maintainer build

With a .NET 9 SDK available, from this directory:

```sh
dotnet publish -r win-x64 -o dist
```

The normal Windows build runs this through `build.mjs`. `build:win` remains an
explicit SDK-dependent target; PE/icon package tests use the committed fixture
and no longer depend on that target.
