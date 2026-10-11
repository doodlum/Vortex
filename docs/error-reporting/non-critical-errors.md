# Non-Critical Error Handling

## Entry Point

`showError()` in `src/renderer/src/util/message.ts` prepares an error and adds its notification. Renderer process only.

## Reporting Decision

`renderError()` can return an explicit `allowReport` decision. That decision takes precedence, including over caller options. When it supplies no decision, `shouldAllowReport()` returns `false` for these cases:

| Condition                        | Reason                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `options.allowReport === false`  | Explicit opt-out by caller                                                           |
| `options.warning === true`       | Warnings are not bugs                                                                |
| `err instanceof ThirdPartyError` | Extension errors aren't Vortex's to report                                           |
| `err instanceof UserCanceled`    | User-initiated, not a bug                                                            |
| `err.code` in `noReportErrors`   | Transient network error (`ETIMEDOUT`, `ECONNREFUSED`, `ECONNABORTED`, `ENETUNREACH`) |

Recording also requires a current version (`!isOutdated()`) and no ignored terminal error (`!didIgnoreError()`). Export separately requires `isTelemetryEnabled()` in the main process: the user must have analytics enabled.

## OTel Recording

When allowed:

```
showError()
  └─ describeError()
       └─ recordErrorSpan(title, error)              src/renderer/src/util/errorHandling.ts
            ├─ active span exists → applyErrorToSpan(activeSpan, ...)
            └─ no active span    → create root span "error.report", applyErrorToSpan, span.end()
                 └─ applyErrorToSpan()
                      └─ recordErrorOnSpan(span, error, appVersion, globalContext)
                           ├─ span.setAttribute("error.fingerprint", ...)
                           ├─ span.recordException(error)
                           └─ span.setStatus({ code: ERROR })
```

ERROR status on the span triggers automatic export in `RingBufferSpanProcessor` — see [telemetry-otel.md](telemetry-otel.md).

## Reusing error details

`describeError(title, details, options)` returns the dialog content and optional report URL used by `showError`. It also logs the error and records an eligible error span. `errorDialogActions(dispatch, description)` builds the Report and Close actions; opening those actions does not record the error again.

When the same failure will also go through an ordinary notification, prepare its status details with recording disabled:

```typescript
const description = describeError(title, details, options, false);
showError(dispatch, title, details, options);
```

The fourth argument avoids logs, spans and diagnostic-field writes during preparation. It runs the normalizer against a shadow with the original property's writability, enumerability and extensibility, so a later notification formats the original Error once. Getter values come from the real Error, which preserves access to private fields such as an HTTP error's status and URL. Ordinary `showError` retains its existing in-place normalization.

Supplied stack strings are retained. Reading an unmaterialized V8 stack during a preview can capture its header before the later notification humanizes the message. Errors constructed for string or plain-object details also include the `describeError` helper frame, so their generated fingerprints need not match the earlier `showError` callsite. These helpers do not promise byte-for-byte equivalence of generated stacks.

Tests: `src/renderer/src/util/message.description.test.ts` covers silent/notification content, readonly and branded errors, recording gates and supplied stacks. Deployment-specific fallback coverage is in `src/renderer/src/extensions/mod_management/util/deploymentFeedback.test.ts`.

## Ambient Context (Legacy)

`globalContext` in `src/renderer/src/util/errorHandling.ts` holds the current operational state (active game, mod being installed, etc.). Entries are attached to every span as `context.<key>` attributes.

```typescript
setErrorContext("gameId", "skyrimse");
```

## State Flags

| Flag           | Set by                                                        | Effect                                                   |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `outdated`     | `setOutdated(api)` — watches `persistent.nexus.newestVersion` | Suppresses reporting when Vortex is behind latest        |
| `errorIgnored` | `disableErrorReport()`, or "Ignore" on a terminal error       | Suppresses reporting after user ignores a terminal error |

## `withTrackedActivity`

Higher-level operations use `withTrackedActivity()` instead of calling `showError()` directly. Wraps an async operation in an OTel span with automatic error recording.

- On success: span status set to `OK`
- On unhandled throw: status set to `ERROR`, exception recorded, re-thrown
- `{ root: true }` starts a new trace — use this for top-level user-initiated operations

**File**: `src/renderer/src/util/errorHandling.ts`

## Extension Error Links

For an eligible, attributed third-party error, the details dialog offers **Report** when a tracker URL can be resolved. The URL comes from `extension.info.issueTrackerURL`, then the installed extension’s mod ID, then its remote mod ID. A mod ID links to that Nexus Mods page’s bugs tab. An extension with no tracker gets an author note instead.

Report opens a confirmation explaining that logs can contain personal information. Continue opens the tracker in the browser; it does not upload the logs.

`src/renderer/src/util/extensionErrorOptions.ts` applies the calling or named extension’s attribution when preparing details outside a notification. `ExtensionManager` applies the same metadata to ordinary `api.showErrorNotification` calls.

## Errors already recorded by an activity

When a tracked activity owns the error span, prepare the details with
`describeError(title, error, options, true, false)`. This keeps normal formatting and logging
while leaving telemetry to the activity. Use `showErrorDescription(dispatch, description, options)`
to display those prepared details without logging or recording them again. The normal
`showError` path still prepares, logs and records its own error. Do not disable its recording
unless another path actually records the same failure.
