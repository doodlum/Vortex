/**
 * An install that fails while its collection's dependency notifications are aggregated: the
 * REAL InstallContext routes its notification through the REAL NotificationAggregator, and the
 * text's placeholders must still have their values when the aggregator shows it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeApiHarness } from "../../test-utils/builders";
import type { IExtensionApi } from "../../types/IExtensionContext";
import InstallContext from "./InstallContext";
import { NotificationAggregator } from "./NotificationAggregator";

const SOURCE = "collection-1";
const AGGREGATION = `install-dependencies-${SOURCE}`;

describe("InstallContext under dependency aggregation", () => {
  const shown = { showErrorNotification: vi.fn(), sendNotification: vi.fn() };
  let aggregator: NotificationAggregator;
  let ctx: InstallContext;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    aggregator = new NotificationAggregator(shown as unknown as IExtensionApi);
    aggregator.startAggregation(AGGREGATION, 0);
    ctx = new InstallContext("skyrimse", makeApiHarness().api, false, aggregator, SOURCE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async () => {
    await vi.runAllTimersAsync();
    const done = aggregator.flushAggregation(AGGREGATION);
    await vi.runAllTimersAsync();
    await done;
  };

  test("a failed install's notification names the mod", async () => {
    ctx.startIndicator("Some Mod-123");
    ctx.finishInstallCB("failed", undefined, "bad archive");
    ctx.stopIndicator();
    await flush();

    expect(shown.showErrorNotification).toHaveBeenCalledWith(
      "{{id}} failed to install",
      expect.anything(),
      expect.objectContaining({ replace: { id: "Some Mod-123" } }),
    );
  });

  test("an install error keeps the values its message refers to", async () => {
    ctx.startIndicator("Some Mod-123");
    ctx.reportError('Failed to clean up "{{destinationPath}}"', "busy", false, {
      destinationPath: "C:\\staging\\Some Mod-123",
    });
    await flush();

    expect(shown.showErrorNotification).toHaveBeenCalledWith(
      'Failed to clean up "{{destinationPath}}"',
      expect.anything(),
      expect.objectContaining({ replace: { destinationPath: "C:\\staging\\Some Mod-123" } }),
    );
  });
});
