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

The API report and declaration typecheck cache inputs include the declaration as
an output of their dependency tasks. A normal source-file glob omits this ignored
generated file, so a declaration change can otherwise replay an old report or a
cached successful typecheck.

The same package test command also runs the installed Nx against disposable Git
workspaces using the production API target inputs, dependencies and outputs. An
inert producer replaces renderer declaration generation, and a copying consumer
replaces report extraction; the typecheck uses the installed TypeScript compiler.
The checks change generated declarations across successive builds, require a
syntax-invalid declaration to fail typechecking, and verify cache reuse for an
unchanged declaration, including report output restoration. They need Git on PATH
and additional temporary space for a private Nx cache. This covers task-cache
invalidation; it does not replace a real renderer build or API extraction.

On Windows, a child process can briefly retain a temporary workspace as its current directory after its command finishes. Fixture cleanup retries supported busy/access errors for at most five retries with a 100 ms increasing delay, then reports the error. The Windows checks use real child processes to cover both a released directory and a lock that outlasts the retry window. The workspace boundary checks and junction target remain intact.
