# INI files on Windows and Linux

This workspace package replaces the bundled consumers of vortex-parse-ini. It
provides IniParser, IniFile and WinapiFormat with the existing mutable-data and
delta-write shape. Windows uses the existing native profile APIs; Linux uses a
portable file implementation. No dependency source or global filesystem object is patched.

## Read and edit

```ts
import IniParser, { WinapiFormat } from "@nexusmods/ini-parser";

const parser = new IniParser(new WinapiFormat());
const file = await parser.read("/absolute/host/path/game.ini");
file.data.General ??= {};
file.data.General.Enabled = "1";
await parser.write("/absolute/host/path/game.ini", file);
```

Paths are native host paths. The caller resolves a game's Proton prefix and
its Documents directory before accessing a file. Bundled INI baking and FOMOD
callbacks resolve Documents paths through the associated Steam game, keep game-directory
INIs in place, and refuse a missing or uninitialized Windows-game prefix. Initialize
the game through Steam and refresh discovery before editing these settings. Native
Linux games and Windows retain their own Documents paths. Automatic Documents mapping
currently requires Steam for Windows games on Linux. A missing file reads as empty;
other filesystem errors propagate. Writes apply only added, removed or changed
keys to the current disk file. After a successful write, further in-place data
mutations are compared with the committed snapshot. A no-op does not rewrite bytes.

The portable format preserves comments, unrelated lines, existing line endings,
key spelling, BOMs and the original file inode, including hardlinks. New lines use
CRLF, matching Windows profile writes. Sections and write-key lookup fold case;
the first matching section block and first matching write key follow the native
API. Section enumeration retains exact spelling, quoted values and duplicate-key
read behavior, rather than assuming GetPrivateProfileString's quote handling.

UTF-8, UTF-8 BOM and UTF-16 BOM files are detected. Non-UTF-8 legacy bytes default
to Windows-1252. For a known different code page, use PortableIniFormat with its
encoding option; iconv-lite's encoding names are accepted. An unrepresentable edit,
incomplete UTF-16 input or multiline value is rejected before writing. UTF-8 BOM
support on Linux deliberately exceeds the old native parser, which treats those
bytes as ANSI. Calls writing the same host path serialize their read-modify-write
transactions. This does not rename source files or impose case folding on host paths.

## Verify

Use the repository's pinned Node and pnpm, then install workspace dependencies.
No game, account or desktop is required for these package tests. From this directory:

```sh
pnpm exec vitest run
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test:integration
```

The fixtures compare portable output bytes and read data with measured Windows
native results for comments, whitespace, duplicate sections/keys, UTF-16 and ANSI.
They also check no-op preservation, Unicode/code pages, hardlink writes, concurrent
deltas, failed writes, repeated edits and prototype-shaped names. On Windows the
same fixtures exercise the actual native backend. The integration command builds the
package, then reads and edits through both published CommonJS and ESM entry points
in fresh Node processes; comments must survive both. On Linux WinapiFormat selects
the portable backend. Passing this package does not prove FOMOD callbacks, INI
baking or every game extension. From `src/renderer`, run:

```sh
pnpm exec vitest run src/extensions/ini_prep/index.test.ts src/extensions/installer_fomod_ipc/delegates/CSharpDelegates.test.ts src/util/linux/gameDocuments.test.ts
```

These use disposable INI files and prefix directories, with no account, installed game
or desktop. They check named/plain tweaks with mixed-case physical filenames, base
comments and manual edits, real delegate string/integer reads, prefix path wiring,
native/Windows controls and missing-prefix failures. Also verify the native app.

The old package remains in main's runtime for third-party extensions which still
import it. Such extensions need their own migration; a vendored Windows-only
parser is not made portable by changing the bundled consumers.

## Bundled game settings and Proton folders

Windows-game settings on Linux use the associated game's initialized Steam Proton
prefix. `util.getGameUserPath(gameId, discovery, "documents", ...subpaths)`
also supports `appData` and `localAppData`. Pass that game's current discovery
record explicitly; the resolver reads the latest Steam snapshot without starting
a scan, and resolves existing subpath spelling on the physical filesystem. It
does not change Vortex's own host-folder service. Native Linux games and Windows
retain their host user folders. A missing Windows-game identity or initialized
prefix raises setup guidance before a settings writer starts; enable Proton,
launch the game once in Steam, and refresh discovery. Automatic prefix mapping
currently requires Steam.

The INI baker, FOMOD delegates, Gamebryo archive invalidation, save/font checks,
local profile settings, Witcher settings and Sims options use this contract.
Flight Simulator uses the same game's prefix AppData and resolves its configured
absolute Windows packages path through that prefix's C drive or mapped Wine
drives with `util.resolveGameWindowsPath`.

From `src/renderer`, run `pnpm run test:integration` for the bundled consumer
boundary. It needs installed workspace/build dependencies and the pinned Node
and pnpm versions, but no game, account, Steam client, Wine process or desktop.
The tests create disposable prefix directories and use a supplied Steam snapshot.
They execute the real Witcher settings writer and Sims setup, retain independent
host sentinel bytes, check Flight Simulator's configured path, and require
Gamebryo/local settings paths to agree with the baker. A lost identity must fail
closed. JavaScript game extensions execute from their actual source with the
extension API and filesystem boundary supplied by the fixture. This is not a
launch or compatibility result for those games. The target is included in root
`pnpm run test`; renderer typechecking also checks the integration project.

Linux Steam game preparation waits for the initial store scan before entering
synchronous game setup and mod-path callbacks. An initialized prefix is checked
after that scan; an absent identity still fails with the setup guidance above.
The resolver never starts a hidden scan from a synchronous callback.

For a Windows relative filename below an already resolved root, extensions can
use `util.resolveCasePath(root, relativePath)`. It normalizes Windows separators
and preserves existing physical component spelling on Linux. Native Linux paths
must keep their ordinary case-sensitive behavior. FOMOD-selected INI names,
Flight Simulator config/Community paths and Oblivion custom-font reads exercise
this final filename boundary. These checks preserve Windows discovery/setup.

The pending-scan and selected-file regressions run from `src/renderer`:

```sh
pnpm exec vitest run src/extensions/gamemode_management/GameModeManager.startup.test.ts src/extensions/installer_fomod_ipc/delegates/CSharpDelegates.test.ts
```

They need the same installed workspace toolchain as the integration target and
create temporary files. They prove setup ordering and selected-file lookup with
a deliberately pending store scan, without requiring a game or account.
