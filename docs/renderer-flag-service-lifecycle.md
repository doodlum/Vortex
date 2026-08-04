# Settings “Failed to render” after a window close attempt

## Symptom

Opening **Settings** could replace the page with a **Failed to render** error. The renderer log contained:

```text
TypeError: Cannot read properties of undefined (reading 'getFlag')
    at useFlag
    at SettingsHealthCheck
```

The failure did not indicate a damaged mod deployment or a game-rendering problem. It occurred in Vortex's React renderer while the health-check settings component evaluated a feature flag.

## Root cause

`FlagService` is a renderer-process singleton initialized during renderer startup. `FlagsProvider` and `useFlag()` expect that singleton to remain available for the lifetime of the React application.

The renderer's `beforeunload` handler called `FlagService.destroyIfInitialized()`. In Electron, `beforeunload` can run for a close or navigation attempt that does not ultimately destroy the renderer. Vortex can therefore keep the existing React tree alive after the handler has reset `FlagService.instance` to `undefined`.

When the user subsequently opened Settings, `SettingsHealthCheck` called `useFlag()`. The context callback then evaluated `FlagService.instance.getFlag(...)` and crashed because the singleton had already been destroyed.

The lifecycle was effectively:

```text
renderer starts
  -> FlagService.init()
  -> close/navigation attempt
  -> beforeunload destroys FlagService
  -> renderer remains alive
  -> SettingsHealthCheck calls useFlag()
  -> render failure
```

## Fix

The fix has two parts:

1. Do not destroy `FlagService` from `beforeunload`. The renderer process owns the singleton, and process teardown already releases its listeners and interval. The handler still flushes pending persistent-state changes synchronously.
2. Make `FlagsProvider` tolerate an unavailable service. Initial state falls back to an empty flag map, subscription is conditional, and flag lookup returns `undefined` if the service is unavailable. A missing optional feature flag can therefore hide its gated control without crashing the Settings page.

The defensive behavior is intentional: feature-flag availability must never be required to render core settings.

## Files changed

- `src/renderer/src/renderer.tsx`
- `src/renderer/src/contexts/FlagsContext.tsx`
- `src/renderer/src/contexts/FlagsContext.test.tsx`

## Regression coverage

The context test suite now verifies that `useFlag()` safely returns `undefined` outside `FlagsProvider`. Existing tests continue to cover initial empty state, subscriptions, updates, unsubscription, typed lookup, and consumer re-rendering.

Verification performed:

- Renderer formatting completed.
- Renderer lint completed.
- Renderer production webpack build completed.
- 169 renderer test files passed.
- 1,647 tests passed and 9 were skipped.

## Manual verification

1. Start Vortex and open **Settings**.
2. Attempt to close or navigate away, including any path that Vortex may cancel or convert into background behavior.
3. Return to the still-running Vortex window.
4. Open **Settings** again.
5. Confirm the page renders and no new `render failure` entry mentioning `getFlag` appears in `vortex.log`.

This issue and fix are independent of collection installation, deployment method, game files, and plugin load order.
