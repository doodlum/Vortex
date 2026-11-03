import { QueryClient, skipToken } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ searchMods: vi.fn() }));

vi.mock("../../nexusV3Client", () => ({
  createVortexNexusV3Client: () => ({ searchMods: mocks.searchMods }),
}));

import type { IExtensionApi } from "@/types/IExtensionContext";
import { queryClient } from "@/util/queryClient";

import { type IModSearchQuery, modSearchKeys, modSearchQuery } from "./modSearch.query";

const api = {} as IExtensionApi;
const now = Date.parse("2026-11-03T12:00:00.000Z");
const search: IModSearchQuery = {
  request: {
    filters: { games: ["skyrimspecialedition"] },
    sort: { field: "endorsements", direction: "desc" },
    pagination: { type: "page", page: 1, page_size: 20 },
  },
  timeRange: "all",
};

const client = () => new QueryClient({ defaultOptions: queryClient.getDefaultOptions() });

describe("modSearchQuery", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.searchMods.mockReset().mockResolvedValue({ mods: [], meta: { total_count: 0 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks for the all-time search as given, and returns the API's result", async () => {
    const response = {
      mods: [{ id: "1" }],
      meta: { type: "page", page: 1, page_size: 20, total_count: 45 },
    };
    mocks.searchMods.mockResolvedValue(response);

    const result = await client().query(modSearchQuery(api, search));

    expect(mocks.searchMods).toHaveBeenCalledWith(search.request);
    expect(result).toEqual(response);
  });

  it.each(["1", "7", "14", "28", "365"] as const)(
    "sends the last %s days as UTC creation bounds without mutating the options",
    async (timeRange) => {
      const options = { ...search, timeRange };
      const before = structuredClone(options);
      await client().query(modSearchQuery(api, options));

      expect(mocks.searchMods).toHaveBeenCalledWith({
        ...search.request,
        filters: {
          ...search.request.filters,
          created_at: {
            gte: new Date(now - Number(timeRange) * 86400000).toISOString(),
            lt: new Date(now).toISOString(),
          },
        },
      });
      expect(options).toEqual(before);
    },
  );

  it("filters update dates when sorting by update time", async () => {
    await client().query(
      modSearchQuery(api, {
        ...search,
        request: { ...search.request, sort: { field: "updated", direction: "asc" } },
        timeRange: "7",
      }),
    );

    expect(mocks.searchMods.mock.calls[0][0].filters).toEqual({
      ...search.request.filters,
      updated_at: { gte: "2026-10-27T12:00:00.000Z", lt: "2026-11-03T12:00:00.000Z" },
    });
  });

  it("advances a refreshed range while keeping the logical cache key stable", async () => {
    const options: IModSearchQuery = { ...search, timeRange: "7" };
    const first = modSearchQuery(api, options);
    const cache = client();
    await cache.query(first);
    vi.mocked(Date.now).mockReturnValue(now + 86400000);
    const refreshed = modSearchQuery(api, structuredClone(options));

    expect(refreshed.queryKey).toEqual(first.queryKey);
    await cache.invalidateQueries({ queryKey: first.queryKey });
    await cache.query(refreshed);

    expect(mocks.searchMods).toHaveBeenCalledTimes(2);
    expect(mocks.searchMods.mock.calls[1][0].filters.created_at).toEqual({
      gte: "2026-10-28T12:00:00.000Z",
      lt: "2026-11-04T12:00:00.000Z",
    });
    expect(modSearchQuery(api, { ...options, timeRange: "28" }).queryKey).not.toEqual(
      first.queryKey,
    );
  });

  it("keys each search by its request and relative range, under every search's key", () => {
    expect(modSearchQuery(api, search).queryKey).toEqual([...modSearchKeys.all, search]);
  });

  it("asks for nothing when it's skipped", () => {
    expect(modSearchQuery(api, skipToken).queryFn).toBe(skipToken);
  });
});
