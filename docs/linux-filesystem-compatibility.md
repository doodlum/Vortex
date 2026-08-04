# Linux extension compatibility

The Linux branch keeps bundled and community extension sources platform-neutral. In particular,
`extensions/` and the `loot` dependency declaration are kept identical to `master`; Linux behavior
belongs at Vortex's extension and packaging boundaries instead.

## Filesystem resolver

On Linux, modules loaded from an extension receive filesystem proxies for the Vortex API, `fs`,
`fs/promises`, and `original-fs`. The proxy resolves path components case-insensitively and accepts
Windows separators before calling the native filesystem. Reads therefore find the existing spelling,
while writes reuse it instead of creating parallel `Data`/`data` or `Plugins`/`plugins` trees.

Deployment uses the same resolver earlier, while planning links, so paths that do not exist yet are
also canonicalized consistently across all mods in a deployment.

## Stock LOOT extension

The Gamebryo plugin-management extension and `node-loot` JavaScript are built from the exact master
sources. The Linux package step supplies platform runtime files separately:

- `node-loot.node` is the Linux N-API binding for the master `node-loot` interface.
- `libloot.so.0` is libloot 0.29.3.
- Vortex's module boundary converts plugin names back to their real on-disk spelling before native
  libloot sees them.
- Vortex's network boundary maps the stock Windows named-pipe string to an absolute Unix socket in
  the temporary directory; the stock `async.js` is copied byte-for-byte and runs from that directory.

The packaged runtime files are in `src/main/assets/loot-linux/`. Their SHA-256 checksums are:

```text
26a2d1ab7fa2d8ef73ac4d62d0a25724478df81ba9f14ac122a37cf9e19eca7b  libloot.so.0
17f3e5b8bb96f988046f229480c80653200f154be3abbf9f586c3648db7f1c16  node-loot.node
```

`src/main/prepare-linux-extensions.mjs` directly invokes the upstream extension build entry points,
because their public `build` scripts intentionally skip non-Windows hosts. It then adds the Linux
runtime artifacts to `dist` without editing extension packages or generated JavaScript.

## Profile files

Profile switching waits for every extension's `profile-will-change` persistence task before copying
profile-owned files. This is a core transaction guarantee, not a Gamebryo-specific workaround, and
prevents delayed writes from being replaced by an older profile snapshot.

## Verification gates

Before release, verify:

```bash
git diff --exit-code master -- extensions pnpm-workspace.yaml
git diff master -- pnpm-lock.yaml | rg 'loot|patchedDependencies'  # must print nothing
node src/main/copy-extensions.mjs
cmp extensions/gamebryo-plugin-management/node_modules/loot/async.js \
  src/main/build/bundledPlugins/gamebryo-plugin-management/async.js
ldd src/main/build/bundledPlugins/gamebryo-plugin-management/node-loot.node
```

The final two checks prove that the stock worker is packaged unchanged and that the native addon
resolves the packaged `libloot.so.0` beside it rather than a build-machine path.
