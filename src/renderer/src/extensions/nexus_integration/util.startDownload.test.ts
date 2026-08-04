import { describe, expect, it, vi } from "vitest";

import { startDownload } from "./util";

describe("startDownload", () => {
  it("queues a Fallout New Vegas nxm link immediately without querying metadata", async () => {
    const emit = vi.fn((event, urls, modInfo, fileName, callback) => {
      expect(event).toBe("start-download");
      expect(urls).toEqual(["nxm://newvegas/mods/123/files/456?key=test&expires=1"]);
      expect(modInfo).toMatchObject({
        game: "falloutnv",
        source: "nexus",
        nexus: {
          ids: { gameId: "newvegas", modId: 123, fileId: 456 },
        },
      });
      expect(fileName).toBeUndefined();
      callback(null, "download-id");
    });
    const api = {
      events: { emit },
      getState: () => ({
        session: {
          gameMode: {
            known: [
              {
                id: "falloutnv",
                name: "Fallout: New Vegas",
                details: { nexusPageId: "newvegas" },
              },
            ],
          },
        },
        settings: { automation: { install: false } },
        persistent: { downloads: { files: {} } },
      }),
      sendNotification: vi.fn(),
      translate: (input: string) => input,
    };
    const nexus = {
      modFilesByUid: vi.fn(() => {
        throw new Error("metadata must not block nxm activation");
      }),
    };

    await expect(
      startDownload(
        api as any,
        nexus as any,
        "nxm://newvegas/mods/123/files/456?key=test&expires=1",
      ),
    ).resolves.toBe("download-id");

    expect(emit).toHaveBeenCalledTimes(1);
    expect(nexus.modFilesByUid).not.toHaveBeenCalled();
  });
});
