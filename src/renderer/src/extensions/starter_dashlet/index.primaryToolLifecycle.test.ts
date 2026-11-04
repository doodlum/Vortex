import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("../../util/fs", () => ({ statAsync: io.stat }));
vi.mock("./Tools", () => ({ default: () => null }));
import { setPrimaryTool } from "./actions";
import init from "./index";
import settingsReducer from "./reducers";
const roots: string[] = [];
beforeEach(() => {
  io.stat.mockReset();
  io.stat.mockImplementation((file: string) => fs.stat(file));
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("vortex-primary-tool-test-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-primary-tool-test-"));
  roots.push(root);
  const executable = path.join(root, "loader");
  const state: any = {
    settings: {
      profiles: { activeProfileId: "p1" },
      interface: { primaryTool: { game: "smapi" } },
      gameMode: {
        discovered: {
          game: {
            path: root,
            name: "Fixture game",
            tools: {
              smapi: {
                id: "smapi",
                name: "SMAPI",
                path: executable,
                workingDirectory: root,
                requiredFiles: ["loader"],
              },
            },
          },
        },
      },
    },
    persistent: {
      profiles: {
        p1: { id: "p1", gameId: "game" },
        p2: { id: "p2", gameId: "game" },
        other: { id: "other", gameId: "other-game" },
      },
    },
    session: {
      gameMode: {
        known: [
          { id: "game", name: "Fixture game", supportedTools: [{ id: "smapi", name: "SMAPI" }] },
        ],
      },
    },
  };
  const notices = new Set(["invalid-primary-tool"]),
    events = new Map<string, any>(),
    changes = new Map<string, any>();
  let check: () => Promise<any>;
  const api: any = {
    store: {
      getState: () => state,
      dispatch: vi.fn((a: any) => {
        if (a.type === "SET_PRIMARY_TOOL") {
          const previous = state.settings.interface.primaryTool;
          state.settings.interface = settingsReducer.reducers.SET_PRIMARY_TOOL(
            state.settings.interface,
            a.payload,
          );
          const current = state.settings.interface.primaryTool;
          changes.get("settings.interface.primaryTool")?.(previous, current);
        }
      }),
    },
    getState: () => state,
    sendNotification: vi.fn((n: any) => {
      notices.add(n.id);
    }),
    dismissNotification: vi.fn((id: string) => notices.delete(id)),
    showErrorNotification: vi.fn(),
    emitAndAwait: vi.fn(async () => []),
    onAsync: vi.fn((name: string, fn: any) => events.set(name, fn)),
    onStateChange: vi.fn((p: string[], fn: any) => changes.set(p.join("."), fn)),
  };
  init({
    api,
    registerReducer: vi.fn(),
    registerDashlet: vi.fn(),
    registerTest: vi.fn((id: string, _trigger: string, fn: any) => {
      if (id === "primary-tool") check = fn;
    }),
    once: (fn: any) => fn(),
  } as any);
  return { root, executable, state, api, notices, events, changes, check: () => check!() };
}
it("clears the stale missing-primary warning after the current executable is repaired", async () => {
  const f = await fixture();
  await f.check();
  expect(f.notices.has("invalid-primary-tool")).toBe(true);
  expect(f.state.settings.interface.primaryTool.game).toBeUndefined();
  await fs.writeFile(f.executable, "owned loader");
  f.state.settings.interface.primaryTool.game = "smapi";
  await f.check();
  expect(f.notices.has("invalid-primary-tool")).toBe(false);
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
});
it("keeps the existing missing-file warning and fallback behavior", async () => {
  const f = await fixture();
  await f.check();
  expect(f.api.sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({ id: "invalid-primary-tool", replace: { toolName: "SMAPI" } }),
  );
  expect(f.state.settings.interface.primaryTool.game).toBeUndefined();
});
it("does not clear a valid custom primary tool", async () => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned custom tool");
  f.state.settings.interface.primaryTool.game = "custom";
  f.state.settings.gameMode.discovered.game.tools.custom = {
    ...f.state.settings.gameMode.discovered.game.tools.smapi,
    id: "custom",
    name: "Custom",
  };
  await f.check();
  expect(f.state.settings.interface.primaryTool.game).toBe("custom");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});
it("retains the selected primary tool when filesystem access fails", async () => {
  const f = await fixture();
  const error = Object.assign(new Error("Owned access failure"), { code: "EACCES" });
  io.stat.mockRejectedValueOnce(error);
  await expect(f.check()).resolves.toBeUndefined();
  expect(f.api.showErrorNotification).toHaveBeenCalled();
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});
it.each(["profile", "selection"])(
  "ignores a late missing-file result after the %s changes",
  async (kind) => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    io.stat.mockImplementationOnce(async (file: string) => {
      await barrier;
      return fs.stat(file);
    });
    const pending = f.check();
    await vi.waitFor(() => expect(io.stat).toHaveBeenCalled());
    if (kind === "profile") f.state.settings.profiles.activeProfileId = "p2";
    else f.state.settings.interface.primaryTool.game = "custom";
    release();
    await pending;
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(f.api.store.dispatch).not.toHaveBeenCalled();
  },
);
it("ignores a late valid result after the discovered executable path changes", async () => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned loader");
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  io.stat.mockImplementationOnce(async (file: string) => {
    await barrier;
    return fs.stat(file);
  });
  const pending = f.check();
  await vi.waitFor(() => expect(io.stat).toHaveBeenCalled());
  f.state.settings.gameMode.discovered.game.tools.smapi = {
    ...f.state.settings.gameMode.discovered.game.tools.smapi,
    path: path.join(f.root, "different-loader"),
  };
  release();
  await pending;
  expect(f.api.dismissNotification).not.toHaveBeenCalled();
});
it.each(["did-deploy", "did-purge"])(
  "rechecks the current primary tool after %s discovery completes",
  async (event) => {
    const f = await fixture();
    await fs.writeFile(f.executable, "owned loader");
    await f.events.get(event)("p1");
    expect(f.api.emitAndAwait).toHaveBeenCalledWith("discover-tools", "game");
    expect(f.notices.has("invalid-primary-tool")).toBe(false);
  },
);
it.each(["did-deploy", "did-purge"])("ignores %s for another profile", async (event) => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned loader");
  await f.events.get(event)("other");
  expect(f.api.emitAndAwait).not.toHaveBeenCalled();
  expect(f.api.store.dispatch).not.toHaveBeenCalled();
  expect(f.api.dismissNotification).not.toHaveBeenCalled();
});
it("validates an actual newly selected primary tool through the registered state hook", async () => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned loader");
  const changed = f.changes.get("settings.interface.primaryTool");
  expect(changed).toBeTypeOf("function");
  f.state.settings.interface.primaryTool = {};
  f.api.store.dispatch(setPrimaryTool("game", "smapi"));
  await vi.waitFor(() => expect(f.notices.has("invalid-primary-tool")).toBe(false));
});
it("reports a non-missing access failure after deployment without failing deployment", async () => {
  const f = await fixture();
  io.stat.mockRejectedValueOnce(
    Object.assign(new Error("Owned access failure"), { code: "EACCES" }),
  );
  await expect(f.events.get("did-deploy")("p1")).resolves.toBeUndefined();
  expect(f.api.showErrorNotification).toHaveBeenCalled();
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
});
it("does not accept an executable directory as a repaired primary tool", async () => {
  const f = await fixture();
  await fs.mkdir(f.executable);
  await f.check();
  expect(f.state.settings.interface.primaryTool.game).toBeUndefined();
  expect(f.notices.has("invalid-primary-tool")).toBe(true);
});
it("preserves non-filesystem launcher selections", async () => {
  const f = await fixture();
  f.state.settings.gameMode.discovered.game.tools.smapi = {
    ...f.state.settings.gameMode.discovered.game.tools.smapi,
    path: "steam://run/owned-fixture",
    requiredFiles: [],
  };
  await f.check();
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});
it("uses the executable directory when the optional working directory is empty", async () => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned loader");
  f.state.settings.gameMode.discovered.game.tools.smapi.workingDirectory = "";
  await f.check();
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});
it("accepts a directory in requiredFiles while checking the executable itself as a file", async () => {
  const f = await fixture();
  await fs.writeFile(f.executable, "owned loader");
  await fs.mkdir(path.join(f.root, "data"));
  f.state.settings.gameMode.discovered.game.tools.smapi.requiredFiles = ["data"];
  await f.check();
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});
it("ignores an old missing-file result after the same tool is selected again and repaired", async () => {
  const f = await fixture();
  let release!: () => void;
  let sampled = false;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  io.stat.mockImplementationOnce(async (file: string) => {
    const result = await fs.stat(file).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    sampled = true;
    await barrier;
    if ("error" in result) throw result.error;
    return result.value;
  });
  const old = f.check();
  await vi.waitFor(() => expect(sampled).toBe(true));
  f.state.settings.interface.primaryTool = { game: undefined };
  f.state.settings.interface.primaryTool = { game: "smapi" };
  await fs.writeFile(f.executable, "repaired loader");
  try {
    await f.check();
  } finally {
    release();
    await old;
  }
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.api.sendNotification).not.toHaveBeenCalled();
  expect(f.notices.has("invalid-primary-tool")).toBe(false);
});

it.each(["missing", "valid"])(
  "ignores an older %s sample after a newer lifecycle validation",
  async (sample) => {
    const f = await fixture();
    if (sample === "valid") await fs.writeFile(f.executable, "owned loader");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sampled!: () => void;
    const sampleReady = new Promise<void>((resolve) => {
      sampled = resolve;
    });
    io.stat.mockImplementationOnce(async (file: string) => {
      const result = await fs.stat(file).then(
        (info) => ({ info }),
        (error) => ({ error }),
      );
      sampled();
      await barrier;
      if ("error" in result) throw result.error;
      return result.info;
    });
    const pending = f.check();
    await sampleReady;
    if (sample === "missing") {
      await fs.writeFile(f.executable, "owned repaired loader");
      await f.events.get("did-deploy")("p1");
      expect(f.notices.has("invalid-primary-tool")).toBe(false);
    } else {
      await fs.unlink(f.executable);
      // Access failure leaves the selection unchanged and the existing warning visible.
      io.stat.mockRejectedValueOnce(
        Object.assign(new Error("Owned access failure"), { code: "EACCES" }),
      );
      await f.events.get("did-purge")("p1");
      expect(f.notices.has("invalid-primary-tool")).toBe(true);
    }
    const notices = f.api.sendNotification.mock.calls.length;
    const dismissals = f.api.dismissNotification.mock.calls.length;
    release();
    await pending;
    expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
    expect(f.api.sendNotification.mock.calls.length).toBe(notices);
    expect(f.api.dismissNotification.mock.calls.length).toBe(dismissals);
  },
);

it("supersedes older checks while lifecycle discovery is pending", async () => {
  const f = await fixture();
  let releaseOld!: () => void, sampled!: () => void, releaseDiscovery!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const sampleReady = new Promise<void>((resolve) => {
    sampled = resolve;
  });
  const discovery = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  io.stat.mockImplementationOnce(async (file: string) => {
    const result = await fs.stat(file).then(
      (info) => ({ info }),
      (error) => ({ error }),
    );
    sampled();
    await barrier;
    if ("error" in result) throw result.error;
    return result.info;
  });
  const old = f.check();
  await sampleReady;
  await fs.writeFile(f.executable, "owned repaired loader");
  f.api.emitAndAwait.mockImplementationOnce(async () => {
    await discovery;
    return [];
  });
  const deployment = f.events.get("did-deploy")("p1");
  await vi.waitFor(() => expect(f.api.emitAndAwait).toHaveBeenCalledWith("discover-tools", "game"));
  releaseOld();
  await old;
  const selectionDuringDiscovery = f.state.settings.interface.primaryTool.game;
  releaseDiscovery();
  await deployment;
  expect(selectionDuringDiscovery).toBe("smapi");
  expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
  expect(f.notices.has("invalid-primary-tool")).toBe(false);
  expect(f.api.sendNotification).not.toHaveBeenCalled();
});

it.each(["stable", "profile", "selection", "same-choice"])(
  "awaits discovery of a selected tool before validation (%s)",
  async (scenario) => {
    const f = await fixture();
    await fs.writeFile(f.executable, "owned deployed loader");
    const tool = f.state.settings.gameMode.discovered.game.tools.smapi;
    delete f.state.settings.gameMode.discovered.game.tools.smapi;
    f.state.settings.interface.primaryTool = {};
    let release!: () => void;
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.api.emitAndAwait.mockImplementation(async () => {
      await discovery;
      f.state.settings.gameMode.discovered.game.tools.smapi = tool;
      return [];
    });
    try {
      f.api.store.dispatch(setPrimaryTool("game", "smapi"));
      await Promise.resolve();
      expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
      expect(f.api.sendNotification).not.toHaveBeenCalled();
      expect(f.api.emitAndAwait).toHaveBeenCalledWith("discover-tools", "game");
      if (scenario === "profile") f.state.settings.profiles = { activeProfileId: "p2" };
      else if (scenario === "selection") {
        f.state.settings.gameMode.discovered.game.tools.custom = { ...tool, id: "custom" };
        f.api.store.dispatch(setPrimaryTool("game", "custom"));
        await vi.waitFor(() => expect(f.notices.has("invalid-primary-tool")).toBe(false));
      } else if (scenario === "same-choice") f.api.store.dispatch(setPrimaryTool("game", "smapi"));
      const priorDismissals = f.api.dismissNotification.mock.calls.length;
      release();
      if (scenario === "stable" || scenario === "same-choice") {
        await vi.waitFor(() => expect(f.notices.has("invalid-primary-tool")).toBe(false));
        expect(f.state.settings.interface.primaryTool.game).toBe("smapi");
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(f.api.dismissNotification.mock.calls.length).toBe(priorDismissals);
        expect(f.state.settings.interface.primaryTool.game).toBe(
          scenario === "selection" ? "custom" : "smapi",
        );
      }
      expect(f.api.sendNotification).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it.each(["current", "profile", "selection", "superseded"])(
  "scopes failed discovery to its current selection (%s)",
  async (scenario) => {
    const f = await fixture();
    await fs.writeFile(f.executable, "owned loader");
    const tool = f.state.settings.gameMode.discovered.game.tools.smapi;
    delete f.state.settings.gameMode.discovered.game.tools.smapi;
    f.state.settings.interface.primaryTool = {};
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, decline) => {
      reject = decline;
    });
    f.api.emitAndAwait.mockImplementationOnce(async () => {
      await pending;
      return [];
    });
    f.api.store.dispatch(setPrimaryTool("game", "smapi"));
    await vi.waitFor(() =>
      expect(f.api.emitAndAwait).toHaveBeenCalledWith("discover-tools", "game"),
    );
    if (scenario === "profile") f.state.settings.profiles = { activeProfileId: "p2" };
    else if (scenario === "selection") f.api.store.dispatch(setPrimaryTool("game", undefined));
    else if (scenario === "superseded") {
      f.state.settings.gameMode.discovered.game.tools.smapi = tool;
      await f.check();
    }
    reject(new Error("Owned delayed tool discovery failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.api.showErrorNotification).toHaveBeenCalledTimes(scenario === "current" ? 1 : 0);
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(f.state.settings.interface.primaryTool.game).toBe(
      scenario === "selection" ? undefined : "smapi",
    );
  },
);
