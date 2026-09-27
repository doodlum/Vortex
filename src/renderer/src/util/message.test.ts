import { describe, expect, it, vi } from "vitest";

vi.mock("./errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));

vi.mock("./log", () => ({ log: vi.fn() }));

// Both are thunks in the app; plain actions here, so the test can read what was raised.
vi.mock("../actions/notifications", () => ({
  addNotification: (notification: unknown) => ({ type: "ADD_NOTIFICATION", payload: notification }),
  showDialog: (type: string, title: string, content: unknown, actions: unknown) => ({
    type: "SHOW_DIALOG",
    payload: { type, title, content, actions },
  }),
}));

import { describeError, errorDialogActions, showError } from "./message";

describe("showError", () => {
  it("raises an error notification whose More opens the details", () => {
    const dispatch = vi.fn();

    showError(dispatch, "Failed to deploy mods", new Error("disk on fire"));

    const notification = dispatch.mock.calls[0][0].payload;
    expect(notification).toMatchObject({ type: "error", message: "Failed to deploy mods" });

    const more = notification.actions.find((action) => action.title === "More");
    more.action(() => undefined);

    const dialog = dispatch.mock.calls[1][0];
    expect(dialog.payload).toMatchObject({
      type: "error",
      title: "Error",
      content: { message: expect.stringContaining("disk on fire") },
    });
  });

  it("offers no details for an error without them", () => {
    const dispatch = vi.fn();

    showError(dispatch, "Something went wrong", undefined, { allowReport: false });

    expect(dispatch.mock.calls[0][0].payload.actions).toEqual([]);
  });

  it("titles the notification when a message is given", () => {
    const dispatch = vi.fn();

    showError(dispatch, "Failed to deploy mod", new Error("no"), { message: "some-mod" });

    expect(dispatch.mock.calls[0][0].payload).toMatchObject({
      title: "Failed to deploy mod",
      message: "some-mod",
    });
  });
});

describe("describeError", () => {
  it("describes the same details dialog showError offers", () => {
    const description = describeError("Failed to deploy mods", new Error("disk on fire"));

    expect(description).toMatchObject({
      title: "Failed to deploy mods",
      content: { message: expect.stringContaining("disk on fire") },
    });
    expect(description.reportURL).toBeUndefined();
  });

  it("sends a third-party extension's error to its issue tracker", () => {
    const description = describeError("Failed", new Error("no"), {
      extension: { info: { issueTrackerURL: "https://example.invalid/issues" } } as never,
      extensionName: "Some Extension",
    });

    expect(description.reportURL).toBe("https://example.invalid/issues");
    expect(errorDialogActions(vi.fn(), description).map((action) => action.label)).toEqual([
      "Report",
      "Close",
    ]);
  });

  it("offers only Close when there is nowhere to report to", () => {
    const description = describeError("Failed", new Error("no"));

    expect(errorDialogActions(vi.fn(), description).map((action) => action.label)).toEqual([
      "Close",
    ]);
  });
});
