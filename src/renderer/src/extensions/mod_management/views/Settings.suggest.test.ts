import { beforeEach, expect, it, vi } from "vitest";

const { suggest } = vi.hoisted(() => ({ suggest: vi.fn() }));
vi.mock("../../gamemode_management/util/discovery", () => ({
  suggestStagingPathFromPaths: suggest,
}));

import { Settings } from "./Settings";

beforeEach(() => {
  suggest.mockReset();
});

function fixture() {
  const onShowError = vi.fn();
  const props = {
    discovery: { path: "/games/Game" },
    modPaths: { "": "/games/Game/Data" },
    suggestInstallPathDirectory: "Vortex Mods",
    installPath: "old",
    onShowError,
  } as unknown as ConstructorParameters<typeof Settings>[0];
  const component = new Settings(props);
  component.nextState = { ...component.state, installPath: "old" };
  window.api.app.getPath = vi.fn().mockResolvedValue("/user-data");
  return {
    component,
    onShowError,
    click: () => (component as unknown as { suggestPath(): Promise<void> }).suggestPath(),
  };
}

it.each(["EACCES", "ELOOP"])(
  "Settings reports %s instead of bypassing resolution",
  async (code) => {
    const { component, onShowError, click } = fixture();
    const error = Object.assign(new Error(code), { code });
    suggest.mockRejectedValue(error);
    await click();
    expect(onShowError).toHaveBeenCalledExactlyOnceWith("Failed to suggest path", error);
    expect(component.nextState.installPath).toBe("old");
  },
);

it.each(["{USERDATA}/{game}/mods", "/physical-drive/Vortex Mods/{game}"])(
  "Settings applies the shared suggestion %s",
  async (result) => {
    const { component, onShowError, click } = fixture();
    suggest.mockResolvedValue(result);
    await click();
    expect(suggest).toHaveBeenCalledExactlyOnceWith(
      "/games/Game/Data",
      "/games/Game",
      "/user-data",
      "Vortex Mods",
    );
    expect(component.nextState.installPath).toBe(result);
    expect(onShowError).not.toHaveBeenCalled();
  },
);
