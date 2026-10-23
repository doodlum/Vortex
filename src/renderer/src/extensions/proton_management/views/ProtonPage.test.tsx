import * as path from "path";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PromiseBB from "bluebird";
import React from "react";
import { beforeEach, expect, it, vi } from "vitest";

import type { IDialogResult } from "@/types/IDialog";
import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";

const mocks = vi.hoisted(() => ({
  state: { current: {} as IState },
  dispatch: vi.fn(),
  entry: vi.fn(),
  install: vi.fn(),
  prefix: vi.fn(),
  getOptions: vi.fn(),
  setOptions: vi.fn(),
  selectVersion: vi.fn(),
  ensure: vi.fn(),
  configure: vi.fn(),
  check: vi.fn(),
  reset: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("react-redux", () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: (state: IState) => unknown) => selector(mocks.state.current),
}));
vi.mock("@/util/Steam", () => ({ default: { reloadGames: vi.fn() } }));
vi.mock("@/util/linux/steamPaths", () => ({ findLinuxSteamPath: () => "/Steam" }));
vi.mock("@/util/linux/steamRevision", () => ({ useSteamGamesRevision: () => 0 }));
vi.mock("@/util/useRelativeTime", () => ({ useRelativeTime: () => "now" }));
vi.mock("@/util/linux/proton", () => ({
  listInstalledProton: async () => [{ name: "Proton", path: "/Proton", source: "steam" }],
  protonConfigName: () => "proton_11",
  findLatestStableProtonName: async () => "proton_11",
  inspectPrefix: mocks.prefix,
}));
vi.mock("../selection", () => ({ activeProtonGame: mocks.entry }));
vi.mock("../modRequirements", () => ({ detectModRuntimeDependencies: async () => ["vcrun2022"] }));
vi.mock("../orchestration", () => ({
  protonCoordinator: () => ({ installManually: mocks.install }),
  currentProtonTarget: (state: IState) => ({
    steamPath: "/Steam",
    game: mocks.entry(),
    key: JSON.stringify([
      state.settings.profiles.activeProfileId,
      mocks.entry()?.gamePath,
      mocks.entry()?.compatDataPath,
    ]),
  }),
}));
vi.mock("../shaderCache", () => ({
  inspectModShaderCache: async () => ({ files: 1, bytes: 4 }),
  inspectPrivateShaderCache: async () => undefined,
  resetPrivateShaderCache: mocks.reset,
  clearModShaderCache: mocks.clear,
}));
vi.mock("../steamShaderSettings", async (original) => ({
  ...(await original<object>()),
  getSteamLaunchOptions: mocks.getOptions,
  setSteamLaunchOptions: mocks.setOptions,
  setSteamCompatTool: mocks.selectVersion,
  ensureShaderCacheWrapper: mocks.ensure,
  configureShaderCache: mocks.configure,
  checkShaderCacheWrapper: mocks.check,
}));
// Layout's scroll observer and SVG asset loader are independent of this page's action contracts.
vi.mock("@/views/components/Page/Page", () => ({
  Page: ({ children }: React.PropsWithChildren) => <main>{children}</main>,
}));
vi.mock("@/views/components/Page/PageScroll", () => ({
  PageScroll: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("@/views/components/Page/Page.context", () => ({
  usePage: () => ({ compact: false, scrolled: false }),
}));
vi.mock("@/ui/components/pictogram/Pictogram", () => ({
  Pictogram: ({ name }: { name: string }) => (
    <svg data-testid="proton-pictogram" data-name={name} />
  ),
}));

import { publishProtonSetupStatus } from "../setupStatus";
import { ProtonPage } from "./ProtonPage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.current = {
    persistent: { profiles: { one: { id: "one", gameId: "game", features: {} } } },
    settings: { profiles: { activeProfileId: "one" }, gameMode: { discovered: {} } },
    session: { base: { toolsRunning: {} } },
  } as unknown as IState;
  mocks.entry.mockReturnValue({
    appid: "22380",
    gamePath: "/Steam/steamapps/common/Game",
    compatDataPath: "/prefix",
  });
  mocks.prefix.mockResolvedValue({ components: ["vcrun2022"], winetricks: [] });
  mocks.getOptions.mockResolvedValue("custom %command%");
  mocks.install.mockResolvedValue(undefined);
});

function view() {
  const api = {
    getState: () => mocks.state.current,
    showDialog: vi.fn().mockResolvedValue({ action: "Cancel" }),
    sendNotification: vi.fn(),
    showErrorNotification: vi.fn(),
  } as unknown as IExtensionApi;
  const rendered = render(<ProtonPage api={api} />);
  return { api, ...rendered };
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId("proton-install-requirements")).not.toBeDisabled());
}

it("restores the full header and management controls; DLL hints alone do not mark recipes installed", async () => {
  view();
  await ready();
  expect(screen.getByTestId("proton-header")).toContainElement(
    screen.getByTestId("proton-pictogram"),
  );
  expect(screen.getByTestId("proton-pictogram")).toHaveAttribute("data-name", "proton");
  expect(screen.getByTestId("proton-automatic")).toHaveAttribute("aria-checked", "true");
  expect(screen.getByTestId("proton-cache-isolation")).toBeEnabled();
  expect(screen.getByTestId("proton-reset-cache")).toBeEnabled();
  fireEvent.click(screen.getByTestId("proton-automatic"));
  expect(mocks.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        profileId: "one",
        featureId: "proton-auto-dependencies",
        value: false,
      }),
    }),
  );
});

it("requires affirmative installation and verifies Winetricks records afterward", async () => {
  const { api } = view();
  await ready();
  fireEvent.click(screen.getByTestId("proton-install-requirements"));
  await waitFor(() => expect(api.showDialog).toHaveBeenCalledOnce());
  expect(mocks.install).not.toHaveBeenCalled();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Install", input: {} });
  mocks.install.mockImplementation(async () => {
    mocks.prefix.mockResolvedValue({ components: [], winetricks: ["vcrun2022"] });
  });
  fireEvent.click(screen.getByTestId("proton-install-requirements"));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByTestId("proton-install-requirements")).toBeDisabled());
  expect(api.showErrorNotification).not.toHaveBeenCalled();
});

it("does not apply a dialog answer to a profile selected afterward", async () => {
  const { api } = view();
  await ready();
  let answer: (result: IDialogResult) => void;
  vi.mocked(api.showDialog).mockReturnValue(
    new PromiseBB<IDialogResult>((resolve) => {
      answer = resolve;
    }),
  );
  fireEvent.click(screen.getByTestId("proton-install-requirements"));
  mocks.state.current.settings.profiles.activeProfileId = "other";
  await act(async () => {
    answer({ action: "Install", input: {} });
  });
  expect(mocks.install).not.toHaveBeenCalled();
});

it("provisions the shader launcher before changing Steam options and preserves a fresh read", async () => {
  const { api } = view();
  await ready();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Enable isolation", input: {} });
  mocks.getOptions.mockResolvedValue("new-custom %command% --game-flag");
  fireEvent.click(screen.getByTestId("proton-cache-isolation"));
  await waitFor(() => expect(mocks.setOptions).toHaveBeenCalledOnce());
  expect(mocks.ensure).toHaveBeenCalledOnce();
  expect(mocks.configure).toHaveBeenCalledWith("22380", [
    path.join("/Steam", "steamapps", "shadercache"),
  ]);
  expect(mocks.setOptions).toHaveBeenCalledWith(
    "22380",
    expect.stringMatching(/^new-custom .*%command% --game-flag$/),
    expect.objectContaining({
      steamPath: "/Steam",
      gamePath: "/Steam/steamapps/common/Game",
      assertCurrent: expect.any(Function),
    }),
  );
  expect(mocks.ensure.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.setOptions.mock.invocationCallOrder[0],
  );
});

it("refuses cache reset while a game or tool is running", async () => {
  mocks.state.current.session.base.toolsRunning = {
    running: { started: 1, exclusive: false, pid: 123 },
  };
  const { api } = view();
  await ready();
  fireEvent.click(screen.getByTestId("proton-reset-cache"));
  expect(api.showDialog).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.reset).not.toHaveBeenCalled();
});

it("refreshes recorded inventory when automatic setup reports ready", async () => {
  view();
  await ready();
  mocks.prefix.mockResolvedValue({ components: [], winetricks: ["vcrun2022"] });
  await act(async () => {
    publishProtonSetupStatus({ phase: "ready", appId: "22380" });
  });
  await waitFor(() => expect(screen.getByTestId("proton-install-requirements")).toBeDisabled());
  expect(mocks.prefix.mock.calls.length).toBeGreaterThan(1);
});

it("binds manual installation to the full selected installation key", async () => {
  const { api } = view();
  await ready();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Install", input: {} });
  fireEvent.click(screen.getByTestId("proton-install-requirements"));
  await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
  expect(mocks.install).toHaveBeenCalledWith(
    JSON.stringify(["one", "/Steam/steamapps/common/Game", "/prefix"]),
    expect.any(Function),
  );
});

it("does not confirm installation into a relocated prefix with the same profile and AppID", async () => {
  const { api } = view();
  await ready();
  let answer!: (result: IDialogResult) => void;
  vi.mocked(api.showDialog).mockReturnValue(
    new PromiseBB<IDialogResult>((resolve) => {
      answer = resolve;
    }),
  );
  fireEvent.click(screen.getByTestId("proton-install-requirements"));
  mocks.entry.mockReturnValue({
    appid: "22380",
    gamePath: "/moved/Game",
    compatDataPath: "/new-prefix",
  });
  await act(async () => {
    answer({ action: "Install", input: {} });
  });
  expect(mocks.install).not.toHaveBeenCalled();
});

it("does not change Steam settings when launcher preflight fails", async () => {
  const { api } = view();
  await ready();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Enable isolation", input: {} });
  mocks.check.mockRejectedValueOnce(new Error("Python unavailable"));
  fireEvent.click(screen.getByTestId("proton-cache-isolation"));
  await waitFor(() => expect(api.showErrorNotification).toHaveBeenCalledOnce());
  expect(mocks.setOptions).not.toHaveBeenCalled();
});
