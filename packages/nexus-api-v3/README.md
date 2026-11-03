# @vortex/nexus-api-v3

Typed HTTP client for the Nexus Mods OpenAPI v3 API.

## Codegen

From this package, run `pnpm codegen` to generate the gitignored declarations in
`src/generated/` from the committed `schema/openapi.yaml` and
`schema/internal/telemetry.yaml`. It does not fetch a schema or run as a
postinstall hook. Nx runs codegen before this package's build, typecheck and lint;
the local schema files are cache inputs. `pnpm build` alone runs tsdown, so run
codegen first when building this package directly after a schema change.

Compare affected endpoints and their referenced schemas with the
[published spec](https://api.nexusmods.com/openapi.yaml) before updating the
committed contract, then run codegen, build, typecheck and `pnpm test` here.
Review callers of changed request and response types too. Tests mock transport;
they do not establish that the live service accepts a request.

## Mod search

The mod-search contract was checked against the published spec on 2026-11-03.
Numbered pages require `pagination.type: "page"`; cursor responses have different
metadata, which `searchMods` preserves. Download sorting uses `downloads`.
Sorting does not filter dates: `created_at` and `updated_at` filters take UTC
date ranges with an inclusive `gte` and exclusive `lt`.

Browse keeps its relative day choices in query options, outside the wire request
and with stable cache keys. At fetch time it converts them to `created_at`
ranges, or `updated_at` when sorting by update time. All time adds no date range.
The query, hook and Browse toolbar tests in the renderer cover those consumers;
run their owning project's tests separately from this package's tests.
