/**
 * An install that fails while its collection's dependency notifications are aggregated: the
 * REAL InstallContext routes its notification through the REAL NotificationAggregator, and the
 * text's placeholders must still have their values when the aggregator shows it.
 */
import { renderHook } from "@testing-library/react";
import { createInstance } from "i18next";
import React from "react";
import { I18nextProvider } from "react-i18next";

import {
  fireNotificationAction,
  closeDialog,
  dismissAllNotifications,
} from "../../actions/notifications";
import { notificationsReducer } from "../../reducers/notifications";
import { showError } from "../../util/message";
import { useNotificationTranslation } from "../../views/components/Spine/notifications/hooks/useNotificationTranslation.hook";

// Override the global key-only translation stub: these tests need the real consumer.
vi.mock("react-i18next", async (importOriginal) => await importOriginal());

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

describe("InstallContext notification consumers", () => {
  const makeConsumer = () => {
    const harness = makeApiHarness({}, [
      { path: ["session", "notifications"], reducer: notificationsReducer },
    ]);
    const api = {
      ...harness.api,
      showErrorNotification: (
        title: string,
        details: string | Error,
        options: Parameters<typeof showError>[3],
      ) => showError(harness.api.store.dispatch, title, details, options),
    } as IExtensionApi;
    const aggregator = new NotificationAggregator(api);
    aggregator.startAggregation(AGGREGATION, 0);
    return { harness, api, aggregator };
  };
  const flush = async (aggregator: NotificationAggregator) => {
    await vi.runAllTimersAsync();
    const pending = aggregator.flushAggregation(AGGREGATION);
    await vi.runAllTimersAsync();
    await pending;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("grouped failed installs render their names through the real notification hook", async () => {
    const { harness, api, aggregator } = makeConsumer();
    for (const id of ["ModA", "ModB"]) {
      const context = new InstallContext("skyrimse", api, false, aggregator, SOURCE);
      context.startIndicator(id);
      context.finishInstallCB("failed", undefined, "bad archive");
      context.stopIndicator();
    }
    await flush(aggregator);
    const notifications = harness.api.getState().session.notifications.notifications;
    expect(notifications).toHaveLength(1);
    const notification = notifications[0];
    expect(notification.message).toBe("{{id}} failed to install (2 dependencies)");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      resources: {},
      initImmediate: false,
    });
    const { result, unmount } = renderHook(
      () => useNotificationTranslation({ notification, collapsed: 1 }),
      {
        wrapper: ({ children }) => React.createElement(I18nextProvider, { i18n }, children),
      },
    );
    expect(result.current.translatedMessage).toBe("ModA, ModB failed to install (2 dependencies)");
    expect(result.current.translatedMessage).not.toContain("{{");
    unmount();
    harness.api.store.dispatch(dismissAllNotifications());
  });

  test("reportError substitutions survive the real More dialog for grouped Error details", async () => {
    const { harness, api, aggregator } = makeConsumer();
    for (const [id, destinationPath] of [
      ["ModA", "C:\\staging\\A"],
      ["ModB", "C:\\staging\\B"],
    ]) {
      const context = new InstallContext("skyrimse", api, false, aggregator, SOURCE);
      context.startIndicator(id);
      const error = new Error('Unable to remove "{{destinationPath}}"');
      error.stack =
        'Error: Unable to remove "{{destinationPath}}"\n    at cleanup (installer.ts:12:3)';
      context.reportError('Failed to clean up "{{destinationPath}}"', error, false, {
        destinationPath,
      });
    }
    await flush(aggregator);
    const notification = harness.api
      .getState()
      .session.notifications.notifications.find((n) => n.type === "error");
    expect(notification).toBeDefined();
    fireNotificationAction(
      notification.id,
      process.type,
      notification.actions.findIndex((a) => a.title === "More"),
      vi.fn(),
    );
    const dialog = harness.api.getState().session.notifications.dialogs[0];
    expect(dialog.content.parameters).toEqual({
      destinationPath: "C:\\staging\\A, C:\\staging\\B",
    });
    expect(dialog.content.text).toContain('Unable to remove "{{destinationPath}}"');
    expect(dialog.content.message).toContain("at cleanup (installer.ts:12:3)");
    expect(dialog.actions).not.toContain("Report");
    const i18n = createInstance();
    await i18n.init({ lng: "en", fallbackLng: "en", resources: {}, initImmediate: false });
    expect(i18n.t(dialog.content.text, { replace: dialog.content.parameters })).toContain(
      'Unable to remove "C:\\staging\\A, C:\\staging\\B"',
    );
    harness.api.store.dispatch(closeDialog(dialog.id, "Close", {}));
    harness.api.store.dispatch(dismissAllNotifications());
  });
});
