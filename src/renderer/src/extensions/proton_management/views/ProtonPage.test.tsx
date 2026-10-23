import * as path from "path";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  resolve: vi.fn(),
  ensure: vi.fn(),
  configure: vi.fn(),
  check: vi.fn(),
  reset: vi.fn(),
  clear: vi.fn(),
  request: vi.fn(),
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
  resolveSteamProton: mocks.resolve,
  steamProtonLabel: (name: string) => (name === "proton_9" ? "Proton 9" : name),
  inspectPrefix: mocks.prefix,
}));
vi.mock("../selection", () => ({ activeProtonGame: mocks.entry }));
vi.mock("../modRequirements", () => ({ detectModRuntimeDependencies: async () => ["vcrun2022"] }));
vi.mock("../orchestration", () => ({
  protonCoordinator: () => ({ installManually: mocks.install, request: mocks.request }),
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
  publishProtonSetupStatus({ phase: "idle" });
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
  mocks.resolve.mockResolvedValue({
    name: "proton_experimental",
    tool: { name: "Proton - Experimental", path: "/Proton" },
    source: "game",
  });
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

it("uses shared themed requirement pills and a readable setup alert with retry", async () => {
  view();
  await ready();
  expect(screen.getByText("vcrun2022").closest(".nxm-pill")).not.toBeNull();
  await act(async () => {
    publishProtonSetupStatus({ phase: "error", appId: "22380", message: "A setup command failed" });
  });
  const alert = screen.getByRole("alert");
  expect(alert).toHaveClass("nxm-alert-danger");
  expect(alert).toHaveTextContent("A setup command failed");
  expect(alert).not.toHaveTextContent("Automatic setup failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
  await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
});

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
  await waitFor(() => expect(screen.queryByTestId("proton-install-requirements")).toBeNull());
  expect(screen.getByText("All requirements installed")).toBeInTheDocument();
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

const setIsolation = (value: boolean) => {
  mocks.state.current.persistent = {
    profiles: {
      one: { id: "one", gameId: "game", features: { "proton-shader-cache-isolation": value } },
    },
  } as never;
};

const isolationChange = () =>
  mocks.dispatch.mock.calls.filter(
    ([action]) => action.payload?.featureId === "proton-shader-cache-isolation",
  );

it("provisions the shader launcher before protecting the cache for Vortex launches", async () => {
  setIsolation(false);
  const { api } = view();
  await ready();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Enable isolation", input: {} });
  fireEvent.click(screen.getByTestId("proton-cache-isolation"));
  await waitFor(() => expect(isolationChange()).toHaveLength(1));
  expect(isolationChange()[0][0].payload.value).toBe(true);
  expect(mocks.ensure).toHaveBeenCalledOnce();
  expect(mocks.configure).toHaveBeenCalledWith("22380", [
    path.join("/Steam", "steamapps", "shadercache"),
  ]);
  expect(mocks.check.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.dispatch.mock.invocationCallOrder.at(-1)!,
  );
});

it("turns protection off without touching the launcher", async () => {
  const { api } = view();
  await ready();
  expect(screen.getByTestId("proton-cache-isolation")).toHaveAttribute("aria-checked", "true");
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Disable isolation", input: {} });
  fireEvent.click(screen.getByTestId("proton-cache-isolation"));
  await waitFor(() => expect(isolationChange()).toHaveLength(1));
  expect(isolationChange()[0][0].payload.value).toBe(false);
  expect(mocks.ensure).not.toHaveBeenCalled();
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
  await waitFor(() => expect(screen.queryByTestId("proton-install-requirements")).toBeNull());
  expect(screen.getByText("All requirements installed")).toBeInTheDocument();
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

it("does not turn on protection when launcher preflight fails", async () => {
  setIsolation(false);
  const { api } = view();
  await ready();
  vi.mocked(api.showDialog).mockResolvedValue({ action: "Enable isolation", input: {} });
  mocks.check.mockRejectedValueOnce(new Error("Python unavailable"));
  fireEvent.click(screen.getByTestId("proton-cache-isolation"));
  await waitFor(() => expect(api.showErrorNotification).toHaveBeenCalledOnce());
  expect(isolationChange()).toHaveLength(0);
});
it("names each setting control by its visible label", async () => {
  view();
  await ready();
  expect(screen.getByRole("checkbox", { name: "Install required components automatically" })).toBe(
    screen.getByTestId("proton-automatic"),
  );
  expect(screen.getByRole("checkbox", { name: "Protect Steam's shader cache" })).toBe(
    screen.getByTestId("proton-cache-isolation"),
  );
});

it("keeps showing the last result while the same installation refreshes", async () => {
  view();
  await ready();
  let finish!: () => void;
  mocks.prefix.mockReturnValue(
    new Promise((resolve) => {
      finish = () => resolve({ components: [], winetricks: [] });
    }),
  );
  fireEvent.click(screen.getByTestId("proton-refresh"));
  await waitFor(() => expect(mocks.prefix.mock.calls.length).toBeGreaterThan(1));
  expect(screen.getByText("vcrun2022")).toBeInTheDocument();
  await act(async () => finish());
});

it("shows an empty state instead of the settings when no Proton game is selected", async () => {
  mocks.entry.mockReturnValue(undefined);
  view();
  expect(await screen.findByText("No Proton game selected")).toBeInTheDocument();
  expect(screen.queryByTestId("proton-automatic")).toBeNull();
});

it("gives keyboard users the reason a cache reset is unavailable", async () => {
  mocks.state.current.session.base.toolsRunning = {
    running: { started: 1, exclusive: false, pid: 123 },
  };
  view();
  await ready();
  const reason = screen.getByLabelText("Exit the game and its tools first");
  expect(reason).toHaveAttribute("tabindex", "0");
  expect(reason).toHaveAttribute("role", "group");
  expect(reason).toContainElement(screen.getByTestId("proton-reset-cache"));
});

it("shows the Proton Steam uses without offering to change it", async () => {
  view();
  await ready();
  const version = screen.getByTestId("proton-version");
  expect(version).toHaveTextContent("Proton - Experimental");
  expect(version).toHaveTextContent("open the game's Properties in Steam");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("names Steam's Proton the way Steam does and flags it when it isn't installed", async () => {
  mocks.resolve.mockResolvedValue({ name: "proton_9", source: "game" });
  view();
  await ready();
  const version = screen.getByTestId("proton-version");
  expect(version).toHaveTextContent("Proton 9");
  expect(version).not.toHaveTextContent("proton_9");
  expect(within(version).getByText("Not installed").closest(".nxm-pill")).not.toBeNull();
});

it("says so when Steam has no Proton choice and none is installed", async () => {
  mocks.resolve.mockResolvedValue({ source: "newest" });
  view();
  await ready();
  const version = screen.getByTestId("proton-version");
  expect(version).toHaveTextContent("No Proton installed");
  expect(version).toHaveTextContent("Steam hasn't chosen a version for this game yet.");
  expect(version).not.toHaveTextContent("The newest Proton installed");
});

it("shows that it is reading Steam's settings until the version is known", async () => {
  mocks.resolve.mockReturnValue(new Promise(() => undefined));
  view();
  expect(await screen.findByText("Reading Steam's settings…")).toBeInTheDocument();
});

it("stops claiming to read Steam's settings once reading them has failed", async () => {
  mocks.resolve.mockRejectedValue(new Error("config.vdf is unreadable"));
  view();
  const version = await screen.findByTestId("proton-version");
  await waitFor(() => expect(version).toHaveTextContent("Couldn't read Steam's settings."));
  expect(version).not.toHaveTextContent("Reading Steam's settings…");
  expect(screen.getByRole("alert")).toHaveTextContent("config.vdf is unreadable");
});
