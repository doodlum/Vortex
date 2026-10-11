import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { UserCanceled } from "@/util/CustomErrors";
import Debouncer from "@/util/Debouncer";
import { recordErrorSpan } from "@/util/errorHandling";

import { setDeploymentControl } from "../actions/session";
import { sessionReducer, type IModsSessionState } from "../reducers/session";
import { completeDeploymentCallback, runDeploymentWithFeedback } from "./deploymentExecution";
import {
  feedbackForRequest,
  finishDeploymentFeedback,
  reportDeploymentIssue,
  startDeploymentFeedback,
} from "./deploymentFeedback";
import { NoDeployment } from "./exceptions";

vi.mock("@/util/errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));
vi.mock("@/util/log", () => ({ log: vi.fn() }));

function fixture(visible = false) {
  const profile = { id: "p", gameId: "game", name: "P", modState: {}, lastActivated: 0 };
  const state = {
    settings: { profiles: { activeProfileId: "p" }, window: { useModernLayout: true } },
    persistent: { profiles: { p: profile, q: { ...profile, id: "q", gameId: "other-game" } } },
    session: { mods: { ...sessionReducer.defaults }, extensions: { available: [] } },
  } as unknown as IState & { session: { mods: IModsSessionState } };
  const dispatch = vi.fn((action: { type: string; payload: unknown }) => {
    const reducer = sessionReducer.reducers[action.type];
    if (reducer) state.session.mods = reducer(state.session.mods, action.payload);
  });
  const api = {
    store: { dispatch, getState: () => state },
    getState: () => state,
    getLoadedExtensions: () => [],
    showErrorNotification: vi.fn(),
    sendNotification: vi.fn(),
  } as unknown as IExtensionApi;
  if (visible) dispatch(setDeploymentControl({ gameId: "game", profileId: "p", owner: "test" }));
  return { api, state, profile };
}

describe("deployment execution outcomes", () => {
  it("joins a UI request and records success only when the engine finishes it", async () => {
    const f = fixture(true),
      request = startDeploymentFeedback(f.api, f.profile);
    const run = vi.fn(async (profile, actual) => {
      expect(profile.id).toBe("p");
      expect(actual).toEqual(request);
      expect(feedbackForRequest(f.state, request)?.state).toBe("running");
      finishDeploymentFeedback(f.api, actual, { state: "deployed" });
    });
    await runDeploymentWithFeedback(f.api, "p", request.requestId, run);
    completeDeploymentCallback(f.api, request, null);
    expect(feedbackForRequest(f.state, request)?.state).toBe("deployed");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps the success notification when the menu control is absent", async () => {
    const f = fixture(),
      request = startDeploymentFeedback(f.api, f.profile);
    await runDeploymentWithFeedback(f.api, "p", request.requestId, async (_profile, actual) => {
      finishDeploymentFeedback(f.api, actual, { state: "deployed" });
    });
    completeDeploymentCallback(f.api, request, null);
    expect(f.api.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mods-deployed", displayMS: 3000 }),
    );
  });

  it("an ignored deployment and a null callback never become success", async () => {
    const f = fixture(),
      request = startDeploymentFeedback(f.api, f.profile);
    await runDeploymentWithFeedback(f.api, "p", request.requestId, async () => {});
    completeDeploymentCallback(f.api, request, null);
    expect(feedbackForRequest(f.state, request)?.state).toBe("canceled");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("a swallowed file failure remains failed after a null callback", async () => {
    const f = fixture(true),
      request = startDeploymentFeedback(f.api, f.profile);
    const files = [{ source: "mod", relPath: "locked", outputPath: "/game/locked" }];
    await runDeploymentWithFeedback(f.api, "p", request.requestId, async (_profile, actual) => {
      reportDeploymentIssue(
        f.api,
        actual,
        { title: "Files failed", options: { allowReport: false }, files },
        vi.fn(),
      );
    });
    completeDeploymentCallback(f.api, request, null);
    expect(feedbackForRequest(f.state, request)).toMatchObject({ state: "failed", files });
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  for (const visible of [true, false]) {
    it("records an early gate/setup failure once, visible=" + visible, async () => {
      vi.mocked(recordErrorSpan).mockClear();
      const f = fixture(visible),
        request = startDeploymentFeedback(f.api, f.profile),
        err = new Error("gate failed");
      await expect(
        runDeploymentWithFeedback(f.api, "p", request.requestId, async () => {
          throw err;
        }),
      ).rejects.toBe(err);
      completeDeploymentCallback(f.api, request, err);
      expect(feedbackForRequest(f.state, request)?.state).toBe("failed");
      expect(f.api.showErrorNotification).toHaveBeenCalledTimes(visible ? 0 : 1);
      expect(recordErrorSpan).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(f.api.sendNotification).not.toHaveBeenCalled();
    });
  }

  it("user cancellation is silent and cannot produce a deployed callback", async () => {
    const f = fixture(),
      request = startDeploymentFeedback(f.api, f.profile),
      err = new UserCanceled();
    await expect(
      runDeploymentWithFeedback(f.api, "p", request.requestId, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    completeDeploymentCallback(f.api, request, err);
    expect(feedbackForRequest(f.state, request)?.state).toBe("canceled");
    expect(f.api.showErrorNotification).not.toHaveBeenCalled();
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("an unavailable method retains a Fix action and disables reporting", async () => {
    const f = fixture(true),
      request = startDeploymentFeedback(f.api, f.profile),
      err = new NoDeployment();
    await expect(
      runDeploymentWithFeedback(f.api, "p", request.requestId, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(feedbackForRequest(f.state, request)).toMatchObject({
      state: "failed",
      fix: "deployment-method",
    });
    expect(feedbackForRequest(f.state, request)?.error?.reportURL).toBeUndefined();
  });

  it("an explicitly deleted queued profile is canceled without using the new active one", async () => {
    const f = fixture(),
      request = startDeploymentFeedback(f.api, f.profile),
      run = vi.fn();
    delete f.state.persistent.profiles.p;
    f.state.settings.profiles.activeProfileId = "q";
    await runDeploymentWithFeedback(f.api, "p", request.requestId, run);
    expect(run).not.toHaveBeenCalled();
    expect(feedbackForRequest(f.state, request)?.state).toBe("canceled");
    expect(f.state.session.mods.deploymentFeedback["other-game"]).toBeUndefined();
  });

  it("starts feedback for callers without a menu request", async () => {
    const f = fixture();
    await runDeploymentWithFeedback(f.api, undefined, undefined, async (profile, request) => {
      expect(profile.id).toBe("p");
      finishDeploymentFeedback(f.api, request, { state: "deployed" });
    });
    expect(f.state.session.mods.deploymentFeedback.game.state).toBe("deployed");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("a stale engine completion cannot settle a newer request", async () => {
    const f = fixture(),
      old = startDeploymentFeedback(f.api, f.profile),
      current = startDeploymentFeedback(f.api, f.profile);
    await runDeploymentWithFeedback(f.api, "p", old.requestId, async (_profile, request) => {
      expect(finishDeploymentFeedback(f.api, request, { state: "deployed" })).toBe(false);
    });
    completeDeploymentCallback(f.api, old, null);
    expect(feedbackForRequest(f.state, current)?.state).toBe("running");
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("real debouncer coalescing cannot turn the replaced game's callback into success", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executed: string[] = [],
      callbacks: string[] = [];
    const timer = new Debouncer(async (id: string, feedbackId: string) => {
      await runDeploymentWithFeedback(f.api, id, feedbackId, async (profile, request) => {
        executed.push(profile.id);
        if (executed.length === 1) await gate;
        finishDeploymentFeedback(f.api, request, { state: "deployed" });
      });
    }, 0);
    const enqueue = (id: string) => {
      const profile = f.state.persistent.profiles[id],
        request = startDeploymentFeedback(f.api, profile);
      timer.runNow(
        (err) => {
          completeDeploymentCallback(f.api, request, err);
          callbacks.push(id);
        },
        id,
        request.requestId,
      );
      return request;
    };
    const first = enqueue("p"),
      replaced = enqueue("q"),
      final = enqueue("p");
    release();
    await vi.waitFor(() => expect(callbacks).toEqual(["p", "q", "p"]));
    expect(executed).toEqual(["p", "p"]);
    expect(feedbackForRequest(f.state, first)).toBeUndefined();
    expect(feedbackForRequest(f.state, replaced)?.state).toBe("canceled");
    expect(feedbackForRequest(f.state, final)?.state).toBe("deployed");
    expect(f.api.sendNotification).toHaveBeenCalledOnce();
  });
  it("real debouncer rejection cancels a coalesced request without borrowing another game's failure", async () => {
    const f = fixture(),
      error = new Error("final request setup failed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executed: string[] = [],
      callbacks: string[] = [],
      errors: Array<Error | null> = [];
    const timer = new Debouncer(async (id: string, feedbackId: string) => {
      await runDeploymentWithFeedback(f.api, id, feedbackId, async (profile, request) => {
        executed.push(profile.id);
        if (executed.length === 1) {
          await gate;
          finishDeploymentFeedback(f.api, request, { state: "deployed" });
        } else throw error;
      });
    }, 0);
    const enqueue = (id: string) => {
      const request = startDeploymentFeedback(f.api, f.state.persistent.profiles[id]);
      timer.runNow(
        (err) => {
          completeDeploymentCallback(f.api, request, err);
          callbacks.push(id);
          errors.push(err);
        },
        id,
        request.requestId,
      );
      return request;
    };
    enqueue("p");
    const replaced = enqueue("q"),
      final = enqueue("p");
    release();
    await vi.waitFor(() => expect(callbacks).toEqual(["p", "q", "p"]));
    expect(executed).toEqual(["p", "p"]);
    expect(errors).toEqual([null, error, error]);
    expect(feedbackForRequest(f.state, replaced)?.state).toBe("canceled");
    expect(feedbackForRequest(f.state, final)?.state).toBe("failed");
    f.state.settings.profiles.activeProfileId = "q";
    expect(f.state.session.mods.deploymentFeedback["other-game"].state).toBe("canceled");
    expect(f.api.showErrorNotification).toHaveBeenCalledOnce();
    expect(f.api.sendNotification).not.toHaveBeenCalled();
  });

  it("external rejected-error callbacks keep sole ownership of their notification", async () => {
    vi.mocked(recordErrorSpan).mockClear();
    const f = fixture(),
      err = new Error("external setup failed");
    await expect(
      runDeploymentWithFeedback(f.api, "p", undefined, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(f.state.session.mods.deploymentFeedback.game.state).toBe("failed");
    expect(f.api.showErrorNotification).not.toHaveBeenCalled();
    expect(recordErrorSpan).not.toHaveBeenCalled();
  });

  it("automatic success keeps its status without adding a manual-success toast", async () => {
    const f = fixture(),
      request = startDeploymentFeedback(f.api, f.profile);
    finishDeploymentFeedback(f.api, request, { state: "deployed" });
    completeDeploymentCallback(f.api, request, null, false);
    expect(f.api.sendNotification).not.toHaveBeenCalled();
    expect(feedbackForRequest(f.state, request)?.state).toBe("deployed");
  });
});
