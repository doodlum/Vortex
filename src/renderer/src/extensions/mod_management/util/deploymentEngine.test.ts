import { CycleError } from "@vortex/shared/errors";
import { recordErrorOnSpan } from "@vortex/shared/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { ProcessCanceled, TemporaryError, UserCanceled } from "@/util/CustomErrors";
import { recordErrorSpan } from "@/util/errorHandling";
import { showError } from "@/util/message";

import { setDeploymentControl, addDeploymentFailures } from "../actions/session";
import { genUpdateModDeployment } from "../index";
import type InstallManager from "../InstallManager";
import { sessionReducer, type IModsSessionState } from "../reducers/session";
import type { IDeploymentMethod } from "../types/IDeploymentMethod";
import { startDeploymentFeedback, feedbackForRequest } from "./deploymentFeedback";

const boundary = vi.hoisted(() => ({
  method: undefined as unknown,
  available: true,
  game: undefined as unknown,
  reasons: { errors: [] as unknown[], warnings: [] as unknown[] },
}));
vi.mock("../InstallManager", () => ({ default: class {} }));
vi.mock("./ModHistory", () => ({ default: class {} }));
vi.mock("./sort", () => ({ default: vi.fn(async () => []) }));
vi.mock("./activationStore", () => ({
  withActivationLock: (run: () => Promise<void>) => run(),
  loadActivation: vi.fn(async () => []),
  saveActivation: vi.fn(async () => {}),
}));
vi.mock("./externalChanges", () => ({ dealWithExternalChanges: vi.fn(async () => {}) }));
vi.mock("./deploymentMethods", () => ({
  getCurrentActivator: () => (boundary.available ? boundary.method : undefined),
  getSelectedActivator: () => boundary.method,
  getAllActivators: () => [],
  getSupportedActivators: () => [],
  registerDeploymentMethod: vi.fn(),
}));
vi.mock("./allTypesSupported", () => ({ default: () => boundary.reasons }));
vi.mock("../../gamemode_management/util/getGame", () => ({ getGame: () => boundary.game }));
vi.mock("../../analytics/mixpanel/deployAnalytics", () => ({ emitModsDeployed: vi.fn() }));
vi.mock("../../analytics/utils/modListSnapshot", () => ({ emitModListSnapshot: vi.fn() }));
vi.mock("@/util/application", () => ({ getApplication: () => ({ version: "1.2.3" }) }));
vi.mock("@vortex/shared/telemetry", async (original) => ({
  ...(await original<object>()),
  recordErrorOnSpan: vi.fn(),
}));
vi.mock("@/util/errorHandling", async (original) => ({
  ...(await original<object>()),
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));
vi.mock("@/util/log", () => ({ log: vi.fn() }));

function fixture(visible = true) {
  const profile = { id: "p", gameId: "game", name: "P", modState: {}, lastActivated: 0 };
  const state = {
    settings: {
      profiles: { activeProfileId: "p" },
      window: { useModernLayout: true },
      mods: { installPath: { game: "/staging" } },
      gameMode: { discovered: { game: { path: "/game" } } },
    },
    persistent: { profiles: { p: profile }, mods: { game: {} } },
    session: {
      mods: { ...sessionReducer.defaults },
      base: { toolsRunning: {}, activity: {}, notifications: [] },
      extensions: { available: [] },
    },
  } as unknown as IState & { session: { mods: IModsSessionState } };
  const dispatch = vi.fn((action: unknown): unknown => {
    if (typeof action === "function") return action(dispatch);
    const value = action as { type: string; payload: unknown };
    const reduce = sessionReducer.reducers[value.type];
    if (reduce) state.session.mods = reduce(state.session.mods, value.payload);
    return action;
  });
  const emitAndAwait = vi.fn(async (_event: string, ..._args: unknown[]) => {});
  let nextNotification = 0;
  const api = {
    store: { dispatch, getState: () => state },
    getState: () => state,
    getLoadedExtensions: () => [],
    events: { emit: vi.fn() },
    emitAndAwait,
    translate: (s: string) => s,
    sendNotification: vi.fn(() => "notification-" + ++nextNotification),
    dismissNotification: vi.fn(),
    showErrorNotification: vi.fn((title, details, options) =>
      showError(dispatch, title, details, options),
    ),
  } as unknown as IExtensionApi;
  if (visible) dispatch(setDeploymentControl({ gameId: "game", profileId: "p", owner: "test" }));
  const request = startDeploymentFeedback(api, profile);
  const manager = {
    getActiveInstallationCount: () => 0,
    waitForIdle: vi.fn(async () => {}),
    consumeRecentChanges: () => new Set<string>(),
  } as unknown as InstallManager;
  boundary.game = { id: "game", getModPaths: () => ({}) };
  boundary.method = {
    id: "method",
    name: "Method",
    noRedundancy: true,
    userGate: vi.fn(async () => {}),
  };
  const deploy = (manual = true) =>
    genUpdateModDeployment(manager)(api, manual, "p", undefined, {
      manual,
      feedbackId: request.requestId,
    });
  return {
    dispatch,
    api,
    state,
    profile,
    request,
    deploy,
    manager,
    emitAndAwait,
    feedback: () => feedbackForRequest(state, request),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.reasons = { errors: [], warnings: [] };
  boundary.available = true;
});

describe("deployment engine outcome wiring", () => {
  it("success requires pre/deploy/post events and settings bake to finish", async () => {
    const f = fixture();
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "bake-settings") expect(f.feedback()?.state).toBe("running");
    });
    await f.deploy();
    expect(f.emitAndAwait.mock.calls.map((call) => call[0])).toEqual([
      "will-deploy",
      "did-deploy",
      "bake-settings",
    ]);
    expect(f.feedback()?.state).toBe("deployed");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("a running tool fails rather than generating success", async () => {
    const f = fixture();
    f.state.session.base.toolsRunning = { tool: { started: 1, exclusive: false, pid: 123 } };
    await f.deploy();
    expect(f.feedback()).toMatchObject({ state: "failed", warning: true });
    expect(f.emitAndAwait).not.toHaveBeenCalled();
  });

  it("a deleted explicit profile cancels without running any deployment events", async () => {
    const f = fixture();
    delete f.state.persistent.profiles.p;
    await f.deploy();
    expect(f.feedback()?.state).toBe("canceled");
    expect(f.emitAndAwait).not.toHaveBeenCalled();
  });

  it("a game that disappeared rejects and has one reachable error result", async () => {
    const f = fixture();
    boundary.game = undefined;
    await expect(f.deploy()).rejects.toThrow("Game no longer available");
    expect(f.feedback()?.state).toBe("failed");
    expect(recordErrorSpan).toHaveBeenCalledOnce();
    expect(f.api.showErrorNotification).not.toHaveBeenCalled();
  });

  it("missing method stops with a Fix action instead of success", async () => {
    const f = fixture();
    boundary.method = undefined;
    await f.deploy();
    expect(f.feedback()).toMatchObject({ state: "failed", fix: "deployment-method" });
    expect(f.emitAndAwait).not.toHaveBeenCalled();
  });

  it("a settings bake failure remains failed even after file deployment finished", async () => {
    const f = fixture(),
      err = new Error("bake failed");
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "bake-settings") throw err;
    });
    await f.deploy();
    expect(f.feedback()?.state).toBe("failed");
    expect(f.feedback()?.error?.content.message).toBe(err.stack);
    expect(recordErrorSpan).toHaveBeenCalledOnce();
  });

  it("recorded file failures retain the actual file list and prevent success", async () => {
    const f = fixture(),
      files = [{ source: "mod", relPath: "locked", outputPath: "/game/locked" }];
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "bake-settings") f.api.store.dispatch(addDeploymentFailures("game", files));
    });
    await f.deploy();
    expect(f.feedback()).toMatchObject({ state: "failed", files });
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  for (const err of [
    new UserCanceled(),
    new ProcessCanceled("interrupted"),
    new TemporaryError("temporary"),
    Object.assign(new Error("denied"), { code: "EPERM" }),
    Object.assign(new Error("too many"), { code: "EMFILE" }),
    Object.assign(new Error("windows"), { errno: 123 }),
  ]) {
    it("retains caught " + err.name + ":" + err.message + " as a non-success outcome", async () => {
      const f = fixture();
      f.emitAndAwait.mockImplementation(async (event) => {
        if (event === "will-deploy") throw err;
      });
      await f.deploy();
      expect(f.feedback()?.state).toBe(err instanceof UserCanceled ? "canceled" : "failed");
      expect(f.api.sendNotification).not.toHaveBeenCalled();
      expect(f.api.showErrorNotification).not.toHaveBeenCalled();
    });
  }

  it("a rejected automatic gate records its real activity error once without a second quiet error span", async () => {
    const f = fixture();
    (boundary.method as IDeploymentMethod).userGate = vi.fn(async () => {
      throw new Error("gate failure");
    });
    await expect(f.deploy(false)).rejects.toThrow("gate failure");
    expect(f.feedback()?.state).toBe("failed");
    expect(recordErrorOnSpan).toHaveBeenCalledOnce();
    expect(recordErrorSpan).not.toHaveBeenCalled();
    expect(f.api.showErrorNotification).not.toHaveBeenCalled();
  });

  it("a failed post-deployment event retains classic notification fallback", async () => {
    const f = fixture(false);
    f.state.settings.window.useModernLayout = false;
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "did-deploy") throw new Error("post failed");
    });
    await f.deploy();
    expect(f.feedback()?.state).toBe("failed");
    expect(f.api.showErrorNotification).toHaveBeenCalledOnce();
  });
  for (const kind of ["errors", "warnings"] as const) {
    it("an unavailable selected method preserves " + kind + " details and Fix", async () => {
      const f = fixture();
      boundary.available = false;
      boundary.reasons[kind] = [{ description: () => "Method unavailable" }];
      await f.deploy();
      expect(f.feedback()).toMatchObject({ state: "failed", fix: "deployment-method" });
      expect(f.emitAndAwait).not.toHaveBeenCalled();
      expect(recordErrorSpan).not.toHaveBeenCalled();
    });
  }

  it("cycle failures retain the cycle editor data", async () => {
    const f = fixture(),
      cycles = [["a", "b"]];
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "will-deploy") throw new CycleError(cycles);
    });
    await f.deploy();
    expect(f.feedback()).toMatchObject({ state: "failed", warning: true, cycles });
  });

  it("deleting the captured profile while waiting for installers cancels before deployment", async () => {
    const f = fixture();
    f.manager.getActiveInstallationCount = () => 1;
    f.manager.waitForIdle = vi.fn(async () => {
      delete f.state.persistent.profiles.p;
    });
    await f.deploy();
    expect(f.feedback()?.state).toBe("canceled");
    expect(f.emitAndAwait).not.toHaveBeenCalled();
  });

  it("deleting a profile in will-deploy cancels before external changes or did-deploy", async () => {
    const f = fixture();
    f.emitAndAwait.mockImplementation(async (event) => {
      if (event === "will-deploy") delete f.state.persistent.profiles.p;
    });
    await f.deploy();
    expect(f.feedback()?.state).toBe("canceled");
    expect(f.emitAndAwait.mock.calls.map((call) => call[0])).toEqual(["will-deploy"]);
  });

  it("an automatic gate error on Home displays actual notification details without a second telemetry event", async () => {
    const f = fixture(false);
    (boundary.method as IDeploymentMethod).userGate = vi.fn(async () => {
      throw new Error("gate failed outside menu");
    });
    await expect(f.deploy(false)).rejects.toThrow("gate failed outside menu");
    expect(recordErrorOnSpan).toHaveBeenCalledOnce();
    expect(recordErrorSpan).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ADD_NOTIFICATION",
        payload: expect.objectContaining({
          type: "error",
          message: "Failed to deploy mods",
          actions: [{ title: "More" }],
        }),
      }),
    );
    expect(f.feedback()?.state).toBe("failed");
  });
});
