# Building the extension API

The renderer emits the extension API declaration rollup into
`packages/vortex-api/lib/api.d.ts`. The API package then generates the public
report in `etc/vortex.api.md` with API Extractor. To regenerate both in a Vortex
checkout with its dependencies installed, use the pinned Node/pnpm toolchain:

```sh
pnpm api
```

Newly written reports use LF, matching the repository's `.gitattributes`.
The newline setting applies when API Extractor writes a report; it does not
normalize an existing report whose content is unchanged.

Run the package's focused maintainer checks from the repository root:

```sh
pnpm -C packages/vortex-api test
```

This typechecks the test code and invokes the installed API Extractor against
disposable declaration fixtures, using the production newline setting. It checks
both report creation and a later API change. It needs writable temporary space
and symlink or junction support; no running Vortex, display, game or account is
needed. The fixtures are removed when the check finishes.

Run `pnpm run verify` for the complete repository gate after the focused checks.
