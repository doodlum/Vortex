import { queryOptions, skipToken } from "@tanstack/react-query";
import type { components } from "@vortex/nexus-api-v3";

import type { IExtensionApi } from "@/types/IExtensionContext";

import { createVortexNexusV3Client } from "../../nexusV3Client";

/** A mod search, as the v3 API takes it. */
export type ModsSearchRequest = components["schemas"]["ModsSearchRequest"];

/** How far back Browse searches, in days or all time. */
export type ModTimeRange = "1" | "7" | "14" | "28" | "365" | "all";

/** A request with a relative time range, resolved only when it is fetched. */
export interface IModSearchQuery {
  request: ModsSearchRequest;
  timeRange: ModTimeRange;
}

/** A mod in the search's results. */
export type ModSummary = components["schemas"]["ModSummary"];

/** The keys of the mod search queries. */
export const modSearchKeys = {
  /** Every mod search, which refreshing invalidates. */
  all: ["nexus", "mods", "search"] as const,
  /** One search, by its request and relative range; none while skipped. */
  search: (search: IModSearchQuery | undefined) => [...modSearchKeys.all, search] as const,
};

/** Resolve dates at fetch time so refresh advances the range without changing its cache key. */
const requestFor = ({ request, timeRange }: IModSearchQuery): ModsSearchRequest => {
  if (timeRange === "all") {
    return request;
  }

  const now = Date.now();
  const range = {
    gte: new Date(now - Number(timeRange) * 24 * 60 * 60 * 1000).toISOString(),
    lt: new Date(now).toISOString(),
  };
  return {
    ...request,
    filters: {
      ...request.filters,
      [request.sort.field === "updated" ? "updated_at" : "created_at"]: range,
    },
  };
};

/** Search the v3 API, applying Browse's relative range, or nothing for skipToken. */
export const modSearchQuery = (api: IExtensionApi, search: IModSearchQuery | typeof skipToken) =>
  queryOptions({
    queryKey: modSearchKeys.search(search === skipToken ? undefined : search),
    queryFn:
      search === skipToken
        ? skipToken
        : () => createVortexNexusV3Client(api).searchMods(requestFor(search)),
  });
