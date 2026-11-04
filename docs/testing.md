# Testing

How tests are organised and run, and the conventions for component and
extension tests.

## Running tests

`pnpm run test` from the repo root runs unit and integration tests across every
package. It **excludes the E2E suite** (`@vortex/e2e`), which needs a packaged
app and a real game install and runs separately.

To run a single test file or directory, use `pnpm exec vitest run <path>` from
inside the project directory that owns it (e.g. `src/renderer`). `pnpm run
test` itself is an nx invocation across all projects and cannot be scoped.

The E2E harness sets two environment variables. `VORTEX_E2E=1` skips installing
the React and Redux DevTools chrome extensions (`installDevelExtensions` in
`src/main/src/devel.ts`), which otherwise slow the launch and add DevTools
targets the harness would have to ignore. `VORTEX_E2E_HEADLESS=1` makes the
`window:show` IPC handler in `src/main/src/ipcHandlers.ts` a no-op, so windows
stay hidden. Set them only through the harness; a normal dev run wants neither.

Tests are colocated with the code they cover, as `src/**/*.test.ts` (or
`*.test.tsx` for components). Component tests use `vitest` with
`@testing-library/react` v16.

## Build cache outputs

Main's build target must declare each standalone worker and source map in
`src/main/package.json`. Nx restores the declared outputs on a cache hit; an omitted
worker can make a successful cached build fail when the app first hashes a file.

After installing the normal workspace dependencies, run from `src/main`:

```sh
pnpm exec vitest run build-outputs.test.ts
```

This account-free test compares literal `bundleWorker` entries in the real build script
with the cache output declaration. It needs no running app and does not itself prove a
cache round trip. For that check, stop the app and prepare dependencies with the normal
build first. Set `NX_CACHE_DIRECTORY` to a new private temporary directory and keep
`NODE_ENV=production` consistent across both runs. Run from the repo root:

```sh
pnpm exec nx run @vortex/main:build --excludeTaskDependencies --skipRemoteCache --output-style=static
```

Record hashes of `src/main/build/hash-worker.cjs` and its `.map`, then move only those
two generated files to a private backup. Repeat the same command and confirm it reports
a local cache hit and restores both hashes. Keep backups until restoration is verified;
if it fails, restore the generated files before launching the app. Dependency tasks are
excluded only because the normal build already prepared them. This checks the real local
cache contract, separately from an app install or packaged-runtime test.

## Finding elements in component tests

Pick the most specific selector that is unambiguous:

1. **A role**, where exactly one element in the query scope has it. This is the
   closest thing to how a user perceives the UI, so prefer it when it works.
2. **A `data-testid`**, when the element isn't addressable by role, or when
   several elements share the role. Add the attribute to the component:
   `Button`, `Input` and the other UI primitives spread unknown props onto the
   underlying element, and `IToolbarAction` takes a `testId`.

**Don't match on text in a component test.** There's no i18n instance in the
unit test setup, so `t` hands back the translation key it was given. A key can
be shared by several elements and tells you nothing about what the user sees, so
a test that matches on one is both ambiguous and misleading.

Text matching belongs in the E2E suite (`packages/e2e/`), which runs against the
real translations and so can assert on what a user actually reads.

Existing tests are mixed on this: you'll find `getByRole`, `getByTestId` and
`getByText` in roughly equal measure. The rule above is where we're heading, not
a description of every test in the tree.

## Extension tests

If an extension test imports `vortex-api`, add a local `vitest.config.ts` alias
to a `__mocks__/vortex-api.ts`, and mock only the exports the test uses.

```ts
// vitest.config.ts
import * as path from "node:path";

resolve: {
  alias: {
    "vortex-api": path.resolve(import.meta.dirname, "__mocks__/vortex-api.ts"),
  },
}

// __mocks__/vortex-api.ts
import { vi } from "vitest";

export const fs = {};
export const util = {};
export const log = vi.fn();
```

## In-memory filesystem

`@vortex/shared/filesystem` exports `InMemoryFS`, a `FileSystem` implementation
backed by a pure in-memory store instead of the OS, plus an `InMemoryFSBuilder`
for seeding it and a `ChaosFS` decorator for injected faults. Tests use them to
drive the same `FileSystem` surface production code uses, with deterministic
state and no temp directories. Their semantics deliberately mirror the node
backend (`src/main/src/filesystem/backend.ts`), so a test passing against the
in-memory implementation says something about production.

In main-process tests, `setFileSystem`/`resetFileSystem` from
`src/main/src/filesystem/instance.ts` swap the process-wide singleton. In
renderer tests, `installInMemoryFS` from
`src/renderer/src/test-utils/fsApi.ts` replaces `window.api.fs`.

### Key files

- `src/shared/src/fs/in-memory.ts` - the `FileSystem` implementation
- `src/shared/src/fs/in-memory-builder.ts` - seeding
- `src/shared/src/fs/chaos.ts` - fault injection (transient errors like disk-full or locked files)
- `src/main/src/filesystem/instance.ts` - main-process singleton and test swap
- `src/renderer/src/test-utils/fsApi.ts` - `window.api.fs` swap for renderer tests

## See also

- [frontend.md](frontend.md) - renderer conventions, including what to test
- `packages/e2e/` - the Playwright end-to-end suite
