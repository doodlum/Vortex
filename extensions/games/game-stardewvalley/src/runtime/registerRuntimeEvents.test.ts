import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fs as vortexFs } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", async () => {
  const fs = await import("node:fs/promises");
  return {
    fs: {
      statAsync: fs.stat,
      ensureDirWritableAsync: (p: string) => fs.mkdir(p, { recursive: true }),
    },
    log: vi.fn(),
    actions: {
      setPrimaryTool: (gameId: string, toolId?: string) => ({ gameId, toolId }),
      setModsEnabled: vi.fn(async (api, profileId, ids, enabled) => {
        for (const id of ids)
          api.getState().persistent.profiles[profileId].modState[id] = { enabled };
      }),
    },
    selectors: {
      profileById: (s, id) => s.persistent.profiles[id],
      lastActiveProfileForGame: (s) => s.lastProfile,
      discoveryByGame: (s, id) => s.settings.gameMode.discovered[id],
    },
    util: {
      getSafe: (s, keys, fallback) => keys.reduce((v, k) => v?.[k], s) ?? fallback,
      toPromise: (fn) =>
        new Promise((resolve, reject) =>
          fn((err, result) => (err ? reject(err) : resolve(result))),
        ),
    },
  };
});
vi.mock("../smapi/proxy", () => ({
  SMAPIProxy: class {
    find = vi.fn(async () => []);
  },
}));
vi.mock("../configMod", () => ({ onAddedFiles: vi.fn(), onWillEnableMods: vi.fn() }));
vi.mock("../compatibility/updateConflictInfo", () => ({
  updateConflictInfo: vi.fn(async () => undefined),
}));
vi.mock("../smapi/workflow", () => ({ downloadAndInstallSMAPI: vi.fn() }));

import StardewValleyGame from "../game/StardewValleyGame";
import { deploySMAPI } from "../smapi/lifecycle";
import { registerRuntimeEvents } from "./registerRuntimeEvents";

let directory = "";
let state: any;
let api: any;
let handlers: Map<string, (...args: any[]) => any>;
let context: types.IExtensionContext;
const mod = {
  id: "smapi-package",
  type: "SMAPI",
  state: "installed",
  attributes: { modId: 2400, version: "4.5.2" },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "smapi-status-"));
  await writeFile(path.join(directory, "Stardew Valley.exe"), "game fixture");
  handlers = new Map();
  state = {
    lastProfile: "active",
    settings: {
      gameMode: { discovered: { stardewvalley: { path: directory } } },
      interface: { primaryTool: { stardewvalley: undefined } },
    },
    persistent: {
      mods: { stardewvalley: { [mod.id]: mod } },
      profiles: {
        active: {
          id: "active",
          gameId: "stardewvalley",
          modState: { [mod.id]: { enabled: true } },
        },
        other: { id: "other", gameId: "other-game", modState: {} },
      },
    },
  };
  api = {
    getState: () => state,
    store: {
      dispatch: vi.fn((action) => {
        state.settings.interface.primaryTool[action.gameId] = action.toolId;
      }),
    },
    dismissNotification: vi.fn(),
    sendNotification: vi.fn(),
    setStylesheet: vi.fn(),
    addMetaServer: vi.fn(),
    onAsync: (name, handler) => handlers.set(name, handler),
    events: {
      on: (name, handler) => handlers.set(name, handler),
      emit: (name, callback) => {
        if (name === "deploy-mods") {
          void writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader").then(
            () => callback(null),
            callback,
          );
        } else if (name === "start-quick-discovery") {
          state.settings.gameMode.discovered.stardewvalley.tools = {
            smapi: { id: "smapi", path: path.join(directory, "StardewModdingAPI.exe") },
          };
          callback(null);
        }
        return true;
      },
    },
  };
  context = { api, once: (fn: () => void) => fn() } as unknown as types.IExtensionContext;
  registerRuntimeEvents(context);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
async function emit(name: string, profile = "active") {
  const h = handlers.get(name);
  assert.ok(h);
  await h(profile);
}

it("clears the pre-install warning after ordinary deployment finds the SMAPI executable", async () => {
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
  await emit("did-deploy");
  expect(api.dismissNotification).toHaveBeenCalledWith("smapi-missing");
  expect(state.settings.interface.primaryTool.stardewvalley).toBe("smapi");
});
it("clears the primary SMAPI tool after disabling it removes its executable", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  state.settings.interface.primaryTool.stardewvalley = "smapi";
  await emit("did-deploy");
  expect(state.settings.interface.primaryTool.stardewvalley).toBeUndefined();
});
it("clears a missing primary tool after purge even when the mod is disabled", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  state.settings.interface.primaryTool.stardewvalley = "smapi";
  await emit("did-purge");
  expect(state.settings.interface.primaryTool.stardewvalley).toBeUndefined();
});
it("preserves the chosen custom tool during deployment", async () => {
  state.settings.interface.primaryTool.stardewvalley = "custom-tool";
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
  await emit("did-deploy");
  expect(state.settings.interface.primaryTool.stardewvalley).toBe("custom-tool");
});
it("ignores deployment events for other games", async () => {
  await emit("did-deploy", "other");
  expect(api.sendNotification).not.toHaveBeenCalled();
  expect(api.dismissNotification).not.toHaveBeenCalled();
  expect(api.store.dispatch).not.toHaveBeenCalled();
});
it("clears an old missing warning when game setup finds a deployed loader", async () => {
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
  const game = new StardewValleyGame(context);
  await game.setup?.({ path: directory } as types.IDiscoveryResult);
  expect(api.dismissNotification).toHaveBeenCalledWith("smapi-missing");
});
it("offers deployment for an installed but disabled SMAPI instead of downloading it again", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  const game = new StardewValleyGame(context);
  await game.setup?.({ path: directory } as types.IDiscoveryResult);
  const notification = api.sendNotification.mock.calls.at(-1)?.[0];
  expect(notification?.title).toBe("SMAPI is not deployed");
  expect(notification?.actions[0].title).toBe("Deploy");
  await notification.actions[0].action();
  expect(state.persistent.profiles.active.modState[mod.id].enabled).toBe(true);
});

it("does not change the selected profile for a background Stardew deployment", async () => {
  state.persistent.profiles.background = {
    id: "background",
    gameId: "stardewvalley",
    modState: {},
  };
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
  await emit("did-deploy", "background");
  expect(api.store.dispatch).not.toHaveBeenCalled();
  expect(api.dismissNotification).not.toHaveBeenCalled();
});
it("does not clear a missing warning for a directory named like the loader", async () => {
  await mkdir(path.join(directory, "StardewModdingAPI.exe"));
  await emit("did-deploy");
  expect(api.dismissNotification).not.toHaveBeenCalled();
  expect(state.settings.interface.primaryTool.stardewvalley).toBeUndefined();
});
it("leaves launcher and notification state untouched when filesystem access fails", async () => {
  state.settings.interface.primaryTool.stardewvalley = "smapi";
  vi.spyOn(vortexFs, "statAsync").mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  await expect(emit("did-deploy")).rejects.toThrow("denied");
  expect(state.settings.interface.primaryTool.stardewvalley).toBe("smapi");
  expect(api.dismissNotification).not.toHaveBeenCalled();
  expect(api.sendNotification).not.toHaveBeenCalled();
});
it("ignores a completed filesystem check after the selected profile changes", async () => {
  const stat = vortexFs.statAsync;
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
  vi.spyOn(vortexFs, "statAsync").mockImplementationOnce((file) => {
    state.lastProfile = "new-profile";
    return stat(file);
  });
  await emit("did-deploy");
  expect(api.store.dispatch).not.toHaveBeenCalled();
  expect(api.dismissNotification).not.toHaveBeenCalled();
});
it("refreshes the existing recommendation after a generic local-archive install", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  const handler = handlers.get("did-install-mod");
  assert.ok(handler);
  handler("stardewvalley", "archive", mod.id);
  await vi.waitFor(() =>
    expect(api.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "SMAPI is not deployed" }),
    ),
  );
});
it("does not treat an incomplete SMAPI installation as ready to deploy", async () => {
  state.persistent.mods.stardewvalley[mod.id] = { ...mod, state: "installing" };
  await emit("did-deploy");
  expect(api.sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({ title: "SMAPI is not installed" }),
  );
});
it.runIf(process.platform === "linux")(
  "recognizes the native Linux executable without requiring an exe",
  async () => {
    await rm(path.join(directory, "Stardew Valley.exe"));
    await writeFile(path.join(directory, "StardewModdingAPI"), "native loader");
    await emit("did-deploy");
    expect(api.dismissNotification).toHaveBeenCalledWith("smapi-missing");
    expect(state.settings.interface.primaryTool.stardewvalley).toBe("smapi");
  },
);

it("preserves a custom primary tool when the installed-package Deploy action runs discovery", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  state.settings.interface.primaryTool.stardewvalley = "custom-tool";
  const game = new StardewValleyGame(context);
  await game.setup?.({ path: directory } as types.IDiscoveryResult);
  const notification = api.sendNotification.mock.calls.at(-1)?.[0];
  expect(notification.actions[0].title).toBe("Deploy");
  await notification.actions[0].action();
  expect(state.settings.interface.primaryTool.stardewvalley).toBe("custom-tool");
  expect(state.persistent.profiles.active.modState[mod.id].enabled).toBe(true);
  expect(api.dismissNotification).toHaveBeenCalledWith("smapi-missing");
});

it("does not set a primary tool after the profile changes during discovery", async () => {
  api.events.emit = (name, callback) => {
    if (name === "start-quick-discovery") {
      state.lastProfile = "new-profile";
      state.settings.gameMode.discovered.stardewvalley.tools = { smapi: { id: "smapi" } };
    }
    callback(null);
    return true;
  };
  await deploySMAPI(api);
  expect(api.store.dispatch).not.toHaveBeenCalled();
});

it("ignores an old setup path when discovery already selected a different installation", async () => {
  await writeFile(path.join(directory, "StardewModdingAPI.exe"), "old installation loader");
  const selected = path.join(directory, "New Installation");
  await mkdir(selected);
  state.settings.gameMode.discovered.stardewvalley.path = selected;
  const game = new StardewValleyGame(context);
  await game.setup?.({ path: directory } as types.IDiscoveryResult);
  expect(api.dismissNotification).not.toHaveBeenCalled();
  expect(api.sendNotification).not.toHaveBeenCalled();
  expect(api.store.dispatch).not.toHaveBeenCalled();
});

it("replaces the deployment action after the last SMAPI package is removed", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  await new StardewValleyGame(context).setup?.({ path: directory } as types.IDiscoveryResult);
  expect(api.sendNotification.mock.calls.at(-1)?.[0].actions[0].title).toBe("Deploy");
  delete state.persistent.mods.stardewvalley[mod.id];
  // emitAndAwait with no registered listener is a no-op in the app.
  await handlers.get("did-remove-mods")?.("stardewvalley", [mod]);
  const notification = api.sendNotification.mock.calls.at(-1)?.[0];
  expect(notification?.title).toBe("SMAPI is not installed");
  expect(notification?.actions[0].title).toBe("Get SMAPI");
});
it("keeps the deployment action when a failed removal leaves SMAPI installed", async () => {
  state.persistent.profiles.active.modState[mod.id].enabled = false;
  await handlers.get("did-remove-mods")?.("stardewvalley", [mod]);
  expect(api.sendNotification.mock.calls.at(-1)?.[0].actions[0].title).toBe("Deploy");
});
it("ignores removal completion for another game", async () => {
  await handlers.get("did-remove-mods")?.("other-game", []);
  expect(api.sendNotification).not.toHaveBeenCalled();
  expect(api.store.dispatch).not.toHaveBeenCalled();
});

it.each([undefined, {}, { modId: "2400" }, { modId: 9999 }])(
  "recognizes an installer-classified SMAPI package independently of Nexus attributes %j",
  async (attributes) => {
    state.persistent.mods.stardewvalley[mod.id] = { ...mod, attributes };
    const game = new StardewValleyGame(context);
    await game.setup?.({ path: directory } as types.IDiscoveryResult);
    expect(api.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "SMAPI is not deployed" }),
    );
    await writeFile(path.join(directory, "StardewModdingAPI.exe"), "deployed loader");
    await emit("did-deploy");
    expect(state.settings.interface.primaryTool.stardewvalley).toBe("smapi");
  },
);
it.each([
  { ...mod, type: "", attributes: { modId: 2400 } },
  { ...mod, state: "installing" },
])("does not offer deployment for an uninstalled or unclassified loader %j", async (entry) => {
  state.persistent.mods.stardewvalley[mod.id] = entry;
  const game = new StardewValleyGame(context);
  await game.setup?.({ path: directory } as types.IDiscoveryResult);
  expect(api.sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({ title: "SMAPI is not installed" }),
  );
});
