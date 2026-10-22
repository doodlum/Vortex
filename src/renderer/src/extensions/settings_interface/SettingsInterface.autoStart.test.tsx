import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IParameters } from "@vortex/shared/cli";
import React from "react";
import type * as ReactReduxTypes from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import automationReducer from "./reducers/automation";

const { baseState, dispatch, state, setLogin, getLogin, showError } = vi.hoisted(() => {
  const baseState = () => ({
    session: { extensions: { available: [] } },
    settings: {
      automation: { deploy: false, enable: false, install: false, minimized: false, start: false },
      interface: {
        alwaysCompactHeaders: false,
        desktopNotifications: true,
        foregroundDL: false,
        hideTopLevelCategory: false,
        language: "en",
        profilesVisible: true,
        reduceMotion: false,
        relativeTimes: false,
      },
      notifications: { suppress: {} },
      window: { customTitlebar: true, zoomFactor: 1 },
    },
  });

  return {
    baseState,
    dispatch: vi.fn(),
    state: { current: baseState() },
    setLogin: vi.fn<() => Promise<void>>(),
    getLogin: vi.fn<() => Promise<{ openAtLogin: boolean; startMinimized?: boolean }>>(),
    showError: vi.fn(),
  };
});

vi.mock("@/contexts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMainContext: () => ({ api: { emitAndAwait: vi.fn(), showErrorNotification: showError } }),
}));

// The global stub (test-setup.ts) returns keys verbatim, so "{{percent}}%" never becomes
// "70%" — fine for most tests, but this file distinguishes radios by their rendered
// percentage, so it needs real interpolation instead.
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => {
    const t = (key: string, options?: { replace?: Record<string, string | number> }) =>
      key.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.replace?.[name] ?? ""));
    return Object.assign([t, undefined, true], { t, i18n: undefined, ready: true });
  },
}));

// More reads `api` off the legacy ComponentEx context, which this test doesn't set up.
// It's unrelated to the Accessibility section under test, so stub it out rather than
// wiring up that legacy provider.
vi.mock("../../controls/More", () => ({ default: () => null }));

// Toggle's icon glyph loads a real font file from disk (via #icon-sets); irrelevant to
// what this file tests, and there's no fixture font under the test environment's paths.
vi.mock("../../controls/Icon", () => ({ default: () => null }));

vi.mock("react-redux", async () => {
  const actual = await vi.importActual<typeof ReactReduxTypes>("react-redux");

  return {
    ...actual,
    useDispatch: () => dispatch,
    useSelector: (selector: (input: unknown) => unknown) => selector(state.current),
  };
});

import { SettingsInterfaceForm } from "./SettingsInterface";

const startup = { attach: vi.fn(), detach: vi.fn() } as unknown as IParameters;

const renderForm = () =>
  render(
    <SettingsInterfaceForm
      changeStartup={vi.fn()}
      currentLanguage="en"
      extensions={[]}
      languages={[]}
      startup={startup}
      onReloadLanguages={vi.fn()}
    />,
  );

// This suite tests the parent state/IPC contract. The legacy Toggle's presentational
// glyph/DOM behavior is independent; expose its existing props as a semantic switch.
vi.mock("../../controls/Toggle", () => ({
  default: ({
    checked,
    disabled,
    onToggle,
    dataId,
  }: {
    checked: boolean;
    disabled?: boolean;
    onToggle: (value: boolean) => void;
    dataId?: string;
  }) => (
    <button
      aria-checked={checked}
      data-testid={dataId}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onToggle(!checked)}
    />
  ),
}));
vi.mock("@/util/preloadAccess", () => ({
  getPreloadApi: () => ({
    app: { setLoginItemSettings: setLogin, getLoginItemSettings: getLogin },
  }),
}));

interface IAction {
  type: string;
  payload?: unknown;
  meta?: { batch?: boolean };
}
function apply(action: IAction): void {
  if (action.meta?.batch && Array.isArray(action.payload)) {
    for (const child of action.payload) apply(child as IAction);
    return;
  }
  const reducer = automationReducer.reducers[action.type];
  if (reducer)
    state.current.settings.automation = reducer(state.current.settings.automation, action.payload);
}
beforeEach(() => {
  state.current = baseState();
  dispatch.mockReset();
  dispatch.mockImplementation((action: IAction) => {
    apply(action);
    return action;
  });
  setLogin.mockReset();
  setLogin.mockResolvedValue();
  getLogin.mockReset();
  getLogin.mockResolvedValue({ openAtLogin: false });
  showError.mockReset();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("waits for backend confirmation, disables both controls, and prevents overlapping requests", async () => {
  const pending = deferred();
  setLogin.mockReturnValue(pending.promise);
  state.current.settings.automation.start = true;
  renderForm();
  await userEvent.click(screen.getByTestId("start-minimized"));
  expect(state.current.settings.automation.minimized).toBe(false);
  expect(screen.getByTestId("auto-start")).toBeDisabled();
  expect(screen.getByTestId("start-minimized")).toBeDisabled();
  await userEvent.click(screen.getByTestId("auto-start"));
  expect(setLogin).toHaveBeenCalledTimes(1);
  expect(setLogin).toHaveBeenCalledWith({
    openAtLogin: true,
    path: process.execPath,
    args: ["--start-minimized"],
  });
  await act(async () => pending.resolve());
  expect(state.current.settings.automation).toMatchObject({ start: true, minimized: true });
  expect(screen.getByTestId("auto-start")).not.toBeDisabled();
});
it("enables startup only after the request succeeds", async () => {
  const pending = deferred();
  setLogin.mockReturnValue(pending.promise);
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  expect(state.current.settings.automation.start).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
  expect(state.current.settings.automation).toMatchObject({ start: true, minimized: false });
});
it("disabling startup clears minimized state together after confirmation", async () => {
  state.current.settings.automation.start = true;
  state.current.settings.automation.minimized = true;
  const pending = deferred();
  setLogin.mockReturnValue(pending.promise);
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  expect(state.current.settings.automation).toMatchObject({ start: true, minimized: true });
  await act(async () => pending.resolve());
  expect(state.current.settings.automation).toMatchObject({ start: false, minimized: false });
  expect(setLogin).toHaveBeenCalledWith({ openAtLogin: false, path: process.execPath, args: [] });
});
it("denied permission preserves the confirmed Linux state and reports the failure", async () => {
  state.current.settings.automation.start = true;
  state.current.settings.automation.minimized = true;
  setLogin.mockRejectedValue(new Error("permission denied"));
  getLogin.mockResolvedValue({ openAtLogin: true, startMinimized: true });
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
  expect(state.current.settings.automation).toMatchObject({ start: true, minimized: true });
  expect(screen.getByTestId("auto-start")).not.toBeDisabled();
});
it("a partial backend failure refreshes actual Linux state instead of claiming rollback", async () => {
  setLogin.mockRejectedValue(new Error("startup arguments were not preserved"));
  getLogin.mockResolvedValue({ openAtLogin: true, startMinimized: false });
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
  expect(state.current.settings.automation).toMatchObject({ start: true, minimized: false });
});
it("an unavailable state read retains previous settings and permits a retry", async () => {
  setLogin.mockRejectedValueOnce(new Error("unavailable"));
  getLogin.mockRejectedValue(new Error("still unavailable"));
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
  expect(state.current.settings.automation.start).toBe(false);
  await userEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => expect(state.current.settings.automation.start).toBe(true));
  expect(setLogin).toHaveBeenCalledTimes(2);
});
it("platforms without Linux's confirmed argument metadata keep their previous error state", async () => {
  state.current.settings.automation.start = true;
  setLogin.mockRejectedValue(new Error("OS failure"));
  getLogin.mockResolvedValue({ openAtLogin: false });
  renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
  expect(state.current.settings.automation.start).toBe(true);
});
it("a confirmed operation still persists after navigating away without updating an unmounted form", async () => {
  const pending = deferred();
  setLogin.mockReturnValue(pending.promise);
  const view = renderForm();
  await userEvent.click(screen.getByTestId("auto-start"));
  view.unmount();
  await act(async () => pending.resolve());
  expect(state.current.settings.automation.start).toBe(true);
  expect(showError).not.toHaveBeenCalled();
});
