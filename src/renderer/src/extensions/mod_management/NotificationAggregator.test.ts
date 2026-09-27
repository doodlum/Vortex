import { describe, expect, vi, beforeEach, afterEach, test } from "vitest";

import type { IExtensionApi } from "../../types/IExtensionContext";
import { NotificationAggregator } from "./NotificationAggregator";

// Mock API for testing
const mockApi = {
  showErrorNotification: vi.fn(),
  sendNotification: vi.fn(),
};

describe("NotificationAggregator", () => {
  let aggregator: NotificationAggregator;

  beforeEach(() => {
    aggregator = new NotificationAggregator(mockApi as unknown as IExtensionApi);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("should show notifications immediately when aggregation is not active", async () => {
    aggregator.addNotification("test-session", "error", "Test Error", "Test message", "TestMod", {
      allowReport: false,
    });

    // Run any pending timers/setImmediate
    await vi.runAllTimersAsync();

    expect(mockApi.showErrorNotification).toHaveBeenCalledWith("Test Error", "Test message", {
      message: "TestMod",
      allowReport: false,
      actions: undefined,
    });
  });

  test("should aggregate similar notifications", async () => {
    aggregator.startAggregation("test-session", 0);

    aggregator.addNotification(
      "test-session",
      "error",
      "Failed to install dependency",
      "Download failed",
      "Mod1",
    );
    aggregator.addNotification(
      "test-session",
      "error",
      "Failed to install dependency",
      "Download failed",
      "Mod2",
    );
    aggregator.addNotification(
      "test-session",
      "error",
      "Failed to install dependency",
      "Download failed",
      "Mod3",
    );

    const flushPromise = aggregator.flushAggregation("test-session");
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(1);
    const [title, message, options] = mockApi.showErrorNotification.mock.calls[0] as [
      string,
      string,
      { allowReport: unknown; id: string },
    ];
    expect(title).toBe("Failed to install dependency (3 dependencies)");
    expect(message).toContain("Affected dependencies: Mod1, Mod2, Mod3");
    expect(options.allowReport).toBeUndefined();
    expect(options.id).toContain("aggregated-");
  });

  test("should handle different error types separately", async () => {
    aggregator.startAggregation("test-session", 0);

    aggregator.addNotification(
      "test-session",
      "error",
      "Download failed",
      "Connection error",
      "Mod1",
    );
    aggregator.addNotification("test-session", "error", "Invalid URL", "Malformed URL", "Mod2");

    const flushPromise = aggregator.flushAggregation("test-session");
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(2);
  });

  test("should handle many dependencies by truncating the list", async () => {
    aggregator.startAggregation("test-session", 0);

    for (let i = 1; i <= 7; i++) {
      aggregator.addNotification(
        "test-session",
        "error",
        "Failed to install dependency",
        "Download failed",
        `Mod${i}`,
      );
    }

    const flushPromise = aggregator.flushAggregation("test-session");
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(1);
    const [title, message, options] = mockApi.showErrorNotification.mock.calls[0] as [
      string,
      string,
      { allowReport: unknown; id: string },
    ];
    expect(title).toBe("Failed to install dependency (7 dependencies)");
    expect(message).toContain("and 2 more");
    expect(options.allowReport).toBeUndefined();
    expect(options.id).toContain("aggregated-error-Failed to install dependency");
  });

  test("should auto-flush on timeout", async () => {
    aggregator.startAggregation("test-session", 100);

    aggregator.addNotification("test-session", "error", "Test Error", "Test message", "TestMod");

    // Advance timers past the timeout to trigger the auto-flush
    await vi.advanceTimersByTimeAsync(150);

    // Stop the aggregation (which flushes remaining notifications)
    const stopPromise = aggregator.stopAggregation("test-session");
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(1);
  });

  test("should stop aggregation and flush notifications", async () => {
    aggregator.startAggregation("test-session", 0);
    aggregator.addNotification("test-session", "error", "Test Error", "Test message", "TestMod");

    const stopPromise = aggregator.stopAggregation("test-session");
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(1);
    expect(aggregator.isAggregating("test-session")).toBe(false);
  });
});

describe("NotificationAggregator placeholders", () => {
  let aggregator: NotificationAggregator;

  const flush = async (id: string) => {
    const done = aggregator.flushAggregation(id);
    await vi.runAllTimersAsync();
    await done;
  };

  beforeEach(() => {
    aggregator = new NotificationAggregator(mockApi as unknown as IExtensionApi);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("passes a notification's substitutions on when not aggregating", async () => {
    aggregator.addNotification("test-session", "error", "{{id}} failed to install", "boom", "A", {
      replace: { id: "ModA" },
    });
    await vi.runAllTimersAsync();

    expect(mockApi.showErrorNotification).toHaveBeenCalledWith(
      "{{id}} failed to install",
      "boom",
      expect.objectContaining({ replace: { id: "ModA" } }),
    );
  });

  test("keeps a single aggregated notification's substitutions", async () => {
    aggregator.startAggregation("test-session", 0);
    aggregator.addNotification("test-session", "error", "{{id}} failed to install", "boom", "A", {
      replace: { id: "ModA" },
    });
    await flush("test-session");

    expect(mockApi.showErrorNotification).toHaveBeenCalledWith(
      "{{id}} failed to install",
      "boom",
      expect.objectContaining({ replace: { id: "ModA" } }),
    );
  });

  test("names every member of a group that fills a placeholder differently", async () => {
    aggregator.startAggregation("test-session", 0);
    for (const id of ["ModA", "ModB", "ModA"]) {
      aggregator.addNotification("test-session", "error", "{{id}} failed to install", "boom", id, {
        replace: { id, reason: "disk full" },
      });
    }
    await flush("test-session");

    expect(mockApi.showErrorNotification).toHaveBeenCalledTimes(1);
    expect(mockApi.showErrorNotification).toHaveBeenCalledWith(
      "{{id}} failed to install (3 dependencies)",
      expect.anything(),
      expect.objectContaining({ replace: { id: "ModA, ModB", reason: "disk full" } }),
    );
  });

  test("lists at most five values, then a count", async () => {
    aggregator.startAggregation("test-session", 0);
    const ids = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];
    for (const id of ids) {
      aggregator.addNotification("test-session", "error", "{{id}} failed", "boom", id, {
        replace: { id },
      });
    }
    await flush("test-session");

    expect(mockApi.showErrorNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ replace: { id: "M1, M2, M3, M4, M5 and 2 more" } }),
    );
  });

  test("keeps a value only some members of the group supply", async () => {
    aggregator.startAggregation("test-session", 0);
    aggregator.addNotification("test-session", "error", "Install failed", "boom", "A");
    aggregator.addNotification("test-session", "error", "Install failed", "boom", "B", {
      replace: { path: "C:\mods" },
    });
    await flush("test-session");

    expect(mockApi.showErrorNotification).toHaveBeenCalledWith(
      "Install failed (2 dependencies)",
      expect.anything(),
      expect.objectContaining({ replace: { path: "C:\mods" } }),
    );
  });

  test("leaves the substitutions out when no member has any", async () => {
    aggregator.startAggregation("test-session", 0);
    aggregator.addNotification("test-session", "error", "Install failed", "boom", "A");
    await flush("test-session");

    expect(mockApi.showErrorNotification.mock.calls[0][2].replace).toBeUndefined();
  });

  test("passes the substitutions to aggregated warnings", async () => {
    aggregator.startAggregation("test-session", 0);
    aggregator.addNotification("test-session", "warning", "{{id}} needs a look", "hm", "A", {
      replace: { id: "ModA" },
    });
    await flush("test-session");

    expect(mockApi.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "{{id}} needs a look", replace: { id: "ModA" } }),
    );
  });
});
