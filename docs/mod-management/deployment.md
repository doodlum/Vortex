# Deployment status

Vortex deploys enabled mods from its staging folder into the game's folders. After changing
mods or rules, use **Apply** beside Play to deploy those changes. With automatic deployment
enabled, Vortex schedules deployment for you.

While deployment runs or waits to start, Apply shows progress. It cannot start another
deployment during that time. The tooltip shows the current step. A completed deployment
shows **Mods deployed** for three seconds.

If deployment fails, select **Deployment failed** to open the details. Depending on the
problem, the dialog offers:

- **Fix** to choose or repair the deployment method in Settings → Mods.
- **Show** to edit cycles in mod rules.
- **Files** to see files Vortex could not write, with links to their locations.
- **Report** when the error can be reported to a third-party extension's tracker.
- **Retry** to request another deployment yourself.

Vortex does not retry from this status control automatically. Canceling a deployment clears
its progress without showing success. A failure that occurs after files were placed, such as
a failed settings update, still shows failure. A deployment with unwritten files also stays
failed; placing some of the files is not a successful deployment.

The status belongs to the profile that requested deployment. Switching profiles does not
reuse another profile's result. An older details dialog cannot retry a newer request or a
different active profile.

When the matching menu control is absent—for example on Home or in the classic layout—Vortex
keeps its progress and failure notifications. The classic Deploy Mods button uses the same
result handling. Automatic deployment does not add a manual “Mods deployed” notification.

## Renderer implementation

`useDeployMods` creates a session request before emitting `deploy-mods`. Its `feedbackId`
travels in `IDeployOptions` through the deployment debouncer to the engine. Automatic
deployment and the Deployment necessary notification also capture their profile and request.
The debouncer can combine queued calls, so a callback receiving `null` does not establish
that each requesting profile deployed.

The engine records success after pre-deployment, file deployment, post-deployment and settings
preparation finish, and only when no file failures were recorded. Failures and cancellations
cannot be overwritten by a later callback for the same request. A missing explicit profile
is canceled; it never falls back to whichever profile is now active.

The menu replaces a notification only when it has a mounted control for the matching active
game, profile and current request. Cleanup of an older control cannot unregister its replacement.
The file-failure array is a separate contract, shared with single-mod deployment and other
deployment callers.

Extension callers can omit `feedbackId`. They retain the existing callback/rejection contract
and are responsible for reporting rejected pre-deployment errors. Do not fabricate feedback
IDs or infer file-level success from a resolved callback. Existing deployment event consumers
can still receive a resolved callback when the engine handled a failure internally.

## Diagnostics and tests

With the repository dependencies installed, run these focused tests from `src/renderer`:

```powershell
pnpm exec vitest run src/extensions/mod_management/util/deploymentEngine.test.ts src/extensions/mod_management/util/deploymentExecution.test.ts src/extensions/mod_management/hooks/useDeployMods.hook.test.tsx src/extensions/mod_management/hooks/useDeploymentStatus.hook.test.tsx
```

They need no installed game, Nexus account or running Vortex. Their filesystem and game
boundaries are controlled fixtures.

Prepared error details use the same formatting and report restrictions as ordinary error
notifications. A rejected automatic deployment gate is recorded by its tracked activity;
its prepared notification does not record that error a second time. See
[error reporting](../error-reporting/non-critical-errors.md).

`deploymentEngine.test.ts` executes the actual deployment factory with controlled game,
filesystem and event boundaries. It covers early failures, cancellation, gate telemetry,
pre/post-deployment failures, settings preparation, file failures and profile deletion while
waiting. Hook tests cover request correlation, the classic consumer, pending activity and
duplicate clicks while deployment waits. Execution tests cover debouncer coalescing. Status
tests cover profile changes, success expiry and stale dialog actions. These tests do not replace checking deployment with a real game and deployment
method, or checking both menu sizes in a running app.

Retry reads the current deployment method when clicked. If you repair that setting while the failure dialog is open, Retry uses the repaired selection. If the method was removed, it asks you to select one instead.

The expanded Apply button wraps longer result labels inside the button. The collapsed icon keeps the full result as its accessible name and tooltip.
