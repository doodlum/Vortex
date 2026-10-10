# Collections and Phased Installation

How a collection installs: what a phase is, what has to be true before the next
one starts, and the invariants to preserve when changing the phase logic.

## Concept

Collections are curated mod sets that install in phases. Each phase must
complete and deploy before the next begins:

- Phase 0: framework mods (SMAPI, for example)
- Phase 1 and up: content mods depending on earlier phases
- `OPTIONAL_PHASE`: a dedicated trailing phase for optional and recommended
  mods, which install through the same engine as required members, just last

## Key Files

- `src/renderer/src/extensions/mod_management/InstallManager.ts` - The phase
  engine. Its header comment documents the phase lifecycle and the
  `mInstallPhaseState` structure in detail; read that before changing anything
  here.
- `src/renderer/src/extensions/mod_management/util/InstallPhaseTracker.ts` -
  Tracks which phases a collection actually has (`collectionRulePhases`)
- `src/renderer/src/extensions/mod_management/util/rulePhase.ts` - Maps a
  collection rule to its phase, including the `OPTIONAL_PHASE` sentinel
- `src/renderer/src/extensions/mod_management/util/requeueCandidates.ts` -
  Decides what gets requeued when a phase is retried

## Phase lifecycle

```
downloads for phase N finish
  └─ markPhaseDownloadsFinished()
       └─ maybeAdvancePhase()
            ├─ active === 0 AND pending === 0 for phase N?
            │    no ──> wait
            └─ yes ──> pollPhaseSettlement()
                        └─ deploy (isDeploying = true)
                             └─ deployment done (isDeploying = false)
                                  └─ startPendingForPhase(N+1)
```

The completion poll (`pollAllPhasesComplete`) also calls
`driveSelectedOptionals` on each tick, which is how an optional un-ignored after
the initial gather still gets installed.

## Critical rules

When modifying phase logic:

- **Never bypass phase gating, even for optional or recommended mods.** Optionals
  map to the trailing `OPTIONAL_PHASE` via `rulePhase` and install through the
  same phase engine as required members. There is no separate optional round.
- **A selected optional un-ignored after the initial gather is never in that
  pass**, so the completion poll re-drives it: `driveSelectedOptionals` (called
  each `pollAllPhasesComplete` tick) downloads or imports the pending optional,
  then `handleDownloadFinished` queues its install at `OPTIONAL_PHASE`.
- The dialog's "Install optional mods" (`InstallDriver.installRecommended`)
  clears `ignored` and re-runs the normal `install-dependencies` pass. It does
  **not** use `installRecommendationsImpl`, which stays for general
  non-collection mod recommendations.
- **Phase-set backfill** (marking earlier phases finished) iterates the
  collection's real phases (`collectionRulePhases` via `InstallPhaseTracker`),
  never integer `0..phase`. Iterating integers would enumerate the
  `OPTIONAL_PHASE` sentinel.
- **Check both `active === 0` and `pending === 0`** before deploying.
- **Always set `isDeploying` during deployment and clear it after.** Removing
  this guard causes race conditions: new installs during deployment produce file
  conflicts.
- **Call `startPendingForPhase()` after deployment completes**, or queued
  installs for the next phase never start.

## Tests

- `InstallManager.optionalPhaseGate.test.ts` - Optional-phase gating
- `InstallManager.optionals.test.ts` - Optional mod handling
- `util/InstallPhaseTracker.test.ts` - Phase tracking
- `util/rulePhase.test.ts` - Rule-to-phase mapping

All under `src/renderer/src/extensions/mod_management/`.

## See also

- [EXTERNAL-CHANGES.md](EXTERNAL-CHANGES.md) - The External Changes dialog, which
  deployment can trigger

## Reusing downloaded archives

For an exact dependency with `fileMD5`, a matching name or reference tag is
insufficient. Before reusing a settled archive, the installer reads its size
and current MD5. Empty, shortened, inaccessible or changed files cannot count
as verified matches. A stored matching hash does not prove that the file has
stayed unchanged. Fuzzy version references retain their existing selection
rules; an already-installed mod with the matching identity and install choices
can be reused without reading an archive it does not need.

When an existing archive does not satisfy the pin, Vortex fetches a separate
copy. The existing file, download record and other collections' tags stay in
place. Each new network transfer except explicit `replace` uses an exclusive
destination, including transfers whose final server filename was not known at
queue time, choosing a
UUID suffix when the server supplies an occupied filename. New temporary
paths also use UUIDs and are reserved exclusively before starting the transfer;
restarting Vortex's IPC counter cannot truncate a resumed or retained temporary
archive. If a new transfer cannot start, only its newly reserved temporary file
is removed. It uses a hard
link within the download folder, or an exclusive copy where hard links are
unsupported. A finalization error leaves the new bytes at their temporary
path and hashes that path, rather than an occupied destination. The preservation
mode is stored with the download so a restored transfer keeps it after Vortex
restarts. A collection's `allowInstall: false` override is also retained across
restart, so the download adapter cannot bypass collection verification when
automatic installation is enabled. An explicit resume override can change it.
The explicit manual network `replace` download mode is unchanged.

Browser fallback carries the same expected reference. Completed browser files
are copied exclusively to an unoccupied name, with a UUID suffix on collision,
before their temporary file is cleaned up. This protects archives already in
the download folder; it does not change how the browser names temporary files. An incorrect new
download fails the member rather than triggering another download. When no
source exists for a mismatching reused archive, the member fails instead of
installing that file. Download tags initially associate progress and
cancellation with an operation; they are not integrity evidence. A newly
created wrong attempt loses only that operation's provisional tag, preserving
other tags and the archive. Known contradictions cannot enter the install
queue. An unknown recorded digest can still be verified from the current bytes;
selected and bundled optionals follow the same runner and trailing phase gate.
The runner checks current bytes and rechecks the record's state, path, game and
download folder after hashing and again at its extraction handoff.

Archive checks use the captured collection cancellation lifetime. Cancellation
releases the waiting operation; a late hash result cannot rewrite download
metadata, remove a file or start a replacement download. Optional lookup/import
waiting, bookkeeping, phase teardown and completion/settlement polls belong to
the captured operation, so their late results cannot replace a newer round's
tracking or phase. Scheduled settlement cleanup removes only its own phase
promise; late deployment success/failure callbacks cannot drain a newer round's
pending queue or mark its phase deployed. An import already emitted can finish copying independently;
its retired callback cannot tag or queue for the canceled collection. The worker's read can
still finish after the caller has canceled. This does not establish cancellation
of every later installer phase or prevent external software from changing a
file after the check.

The regression suites are `InstallManager.reusedArchive.test.ts`,
`InstallManager.sharedDownloads.test.ts`,
`IPCDownloadAdapter.preservedArchive.test.ts`, `IPCDownloadAdapter.adopt.test.ts` and
`download_management/util/preserveExistingDownload.test.ts`, under the
renderer source directory. They use temporary files and local test seams;
they do not prove a real Nexus collection completed or an installation became
faster. Run them with `pnpm exec vitest run <file>` from `src/renderer`.
