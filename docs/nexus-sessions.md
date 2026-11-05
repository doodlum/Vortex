# Nexus account sessions

Vortex scopes preference caching, user-info validation, OAuth refreshes and membership
freshness to the active account session. A response from an earlier session cannot replace
the current account's user info or sign that account out. Switching away and back creates
a new session marker, even when the final account is the same.

A same-account JWT refresh preserves cached preferences and shared work. Account identity
uses the issuer, application, subject and user ID; a device fingerprint does not identify an
account. Changed opaque tokens start a fresh scope. These comparisons coordinate local
state; Nexus still validates credentials when it receives a request.

Each account lifetime has a separate legacy Nexus SDK instance. A replacement SDK is
authenticated with the current credentials before a network consumer runs. Delayed SDK
priming and key validation cannot mutate the replacement instance. Retained client methods
select the current instance when invoked; logger and game settings carry over. Synchronous
management methods remain synchronous. All public SDK network consumers share the authentication
boundary, including collection search, file contents and metrics. Retired callers are cancelled even while quota work
is pending, and queued work checks ownership before reaching the network primitive. An
already-sent response may update its retired SDK's private rate-limit bookkeeping without
throwing from an HTTP callback or changing the current account's limits. Request argument
serialization and feedback header reads also check ownership after token or file-inspection
waits, immediately before the pinned SDK creates its HTTP request. Feedback also checks
the file-inspection continuation before it allocates an attachment stream.

The Nexus SDK's preference cache can be repopulated by a request that was already in flight
when it was cleared. Vortex therefore keeps its own session-and-query cache and bypasses
the SDK cache on a fresh read. Concurrent reads share one request. Explicit bypass fetches
again, failures permit retry, and cache clearing remains synchronous. The boundary also
covers the SDK's internal preference lookup during user-info reads.

Membership requests, cooldowns and delayed focus/hover triggers belong to the same session.
A replacement account gets its own read. A late refresh refusal cannot clear a new account's
credentials, and a rejected previous-account request cannot acquire the new account's token.
API-key validation callbacks and notification retries also check their originating session.
Replacement API keys receive a fresh validation clock. A login event listener that changes
the account prevents the waiting query from continuing. Fresh login validation is shared
with membership callers, including when login starts after application startup.
Requests already sent may still finish; stale replies are discarded at these boundaries.

## Verify a change

Install the checkout's pinned Node/pnpm dependencies. From `src/renderer`, run on Windows
and native Linux:

```sh
pnpm exec vitest run src/extensions/nexus_integration
```

These account-free tests use synthetic credentials and deferred responses. Client lifetime
tests use actual SDK authentication and quota-call methods with substituted network primitives. Preference tests
exercise the pinned SDK's actual cache methods while replacing its network primitives, with
both native and Bluebird promises. Controls cover normal validation, current refusals,
same-account refresh, cache reuse/bypass and retry. They establish local response, cache and
timer ownership; they do not authenticate two live Nexus accounts.

For packaged acceptance, use an isolated profile. The account owner completes any required
interactive login. Check persisted login, user info and a normal authenticated download,
then restart and repeat the lookup. Retain the package/source identity and first outcomes.
Live account-switch acceptance requires the owner to authorize both accounts; record missing
credentials as a prerequisite instead of treating mocked replies as a live sign-in.
Never include tokens, API keys or refresh credentials in test reports.
