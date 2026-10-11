import { describe, expect, it, vi } from "vitest";

vi.mock("@/util/errorHandling", () => ({
  didIgnoreError: () => false,
  isOutdated: () => false,
  recordErrorSpan: vi.fn(),
}));
vi.mock("@/util/log", () => ({ log: vi.fn() }));

import { HTTPError, StalledError } from "@vortex/shared/errors";

import type { IExtensionApi } from "@/types/IExtensionContext";
import type { IState } from "@/types/IState";
import { recordErrorSpan } from "@/util/errorHandling";
import { showError } from "@/util/message";

import {
  updateDeploymentFeedback,
  setDeploymentControl,
  clearDeploymentControl,
} from "../actions/session";
import { sessionReducer, type IModsSessionState } from "../reducers/session";
import {
  deploymentProfile,
  startDeploymentFeedback,
  finishDeploymentFeedback,
  reportDeploymentIssue,
  canShowDeploymentFeedback,
  feedbackForRequest,
} from "./deploymentFeedback";

const profile = { id: "p", gameId: "game", name: "Fixture", modState: {}, lastActivated: 0 };
function fixture() {
  const state = {
    settings: { window: { useModernLayout: true }, profiles: { activeProfileId: "p" } },
    persistent: {
      profiles: { p: profile, other: { ...profile, id: "other", gameId: "other-game" } },
    },
    session: { mods: { ...sessionReducer.defaults }, extensions: { available: [] } },
  } as unknown as IState & { session: { mods: IModsSessionState } };
  const dispatch = vi.fn((action: { type: string; payload: unknown }) => {
    const reduce = sessionReducer.reducers[action.type];
    if (reduce) state.session.mods = reduce(state.session.mods, action.payload);
  });
  const api = {
    getState: () => state,
    getLoadedExtensions: () => [],
    store: { dispatch, getState: () => state },
  } as unknown as IExtensionApi;
  const mount = (owner = "control") =>
    dispatch(setDeploymentControl({ gameId: "game", profileId: "p", owner }));
  return { state, api, dispatch, mount };
}

describe("deployment feedback ownership", () => {
  it("an explicit deleted profile never deploys the current profile instead", () => {
    const { state } = fixture();
    expect(deploymentProfile(state, "deleted")).toBeUndefined();
    expect(deploymentProfile(state, "other")?.id).toBe("other");
    expect(deploymentProfile(state)?.id).toBe("p");
  });
  it("an older completion cannot overwrite a newer deployment", () => {
    const { api, state } = fixture(),
      old = startDeploymentFeedback(api, profile),
      current = startDeploymentFeedback(api, profile);
    expect(finishDeploymentFeedback(api, old, { state: "deployed" })).toBe(false);
    expect(feedbackForRequest(state, current)?.state).toBe("running");
    expect(
      finishDeploymentFeedback(api, current, {
        state: "failed",
        error: { title: "Failure", content: { text: "retained" } },
      }),
    ).toBe(true);
    expect(finishDeploymentFeedback(api, current, { state: "deployed" })).toBe(false);
    expect(feedbackForRequest(state, current)?.state).toBe("failed");
  });
  it("the real reducer refuses a stale request and a wrong profile", () => {
    const { api, state, dispatch } = fixture(),
      request = startDeploymentFeedback(api, profile);
    dispatch(
      updateDeploymentFeedback({ ...request, requestId: "stale", state: "deployed", changedAt: 2 }),
    );
    dispatch(
      updateDeploymentFeedback({ ...request, profileId: "other", state: "deployed", changedAt: 2 }),
    );
    expect(feedbackForRequest(state, request)?.state).toBe("running");
  });
  it("a stale control cleanup leaves its replacement registered", () => {
    const { state, dispatch, mount } = fixture();
    mount("old");
    mount("new");
    dispatch(clearDeploymentControl("old"));
    expect(state.session.mods.deploymentControl?.owner).toBe("new");
    dispatch(clearDeploymentControl("new"));
    expect(state.session.mods.deploymentControl).toBeUndefined();
  });
  it("feedback is isolated between games", () => {
    const { api, state } = fixture(),
      first = startDeploymentFeedback(api, profile);
    const second = startDeploymentFeedback(api, { ...profile, id: "other", gameId: "other-game" });
    finishDeploymentFeedback(api, first, { state: "deployed" });
    expect(feedbackForRequest(state, first)?.state).toBe("deployed");
    expect(feedbackForRequest(state, second)?.state).toBe("running");
  });
});

describe("deployment notification fallback", () => {
  for (const context of ["Home", "classic", "different-game", "different-profile"] as const) {
    it("keeps failures reachable in " + context, () => {
      vi.mocked(recordErrorSpan).mockClear();
      const { api, state, mount } = fixture(),
        request = startDeploymentFeedback(api, profile),
        notify = vi.fn();
      if (context !== "Home") mount();
      if (context === "classic") state.settings.window.useModernLayout = false;
      if (context === "different-profile") state.settings.profiles.activeProfileId = "other";
      if (context === "different-game") state.session.mods.deploymentControl!.gameId = "other-game";
      expect(canShowDeploymentFeedback(state, request)).toBe(false);
      reportDeploymentIssue(
        api,
        request,
        { title: "Failed", details: new Error("retained") },
        notify,
      );
      expect(notify).toHaveBeenCalledOnce();
      expect(recordErrorSpan).not.toHaveBeenCalled();
      expect(feedbackForRequest(state, request)?.error?.title).toBe("Failed");
    });
  }
  it("a visible exact-profile control replaces the notification and records the error once", () => {
    vi.mocked(recordErrorSpan).mockClear();
    const { api, state, mount } = fixture();
    mount();
    const request = startDeploymentFeedback(api, profile),
      notify = vi.fn();
    expect(canShowDeploymentFeedback(state, request)).toBe(true);
    reportDeploymentIssue(
      api,
      request,
      { title: "Failed", details: new Error("retained") },
      notify,
    );
    expect(notify).not.toHaveBeenCalled();
    expect(recordErrorSpan).toHaveBeenCalledOnce();
    expect(feedbackForRequest(state, request)?.state).toBe("failed");
    reportDeploymentIssue(
      api,
      request,
      { title: "Failed", details: new Error("duplicate") },
      notify,
    );
    expect(recordErrorSpan).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
  it("an old failure remains reachable without replacing a newer result", () => {
    const { api, state, mount } = fixture();
    mount();
    const old = startDeploymentFeedback(api, profile),
      current = startDeploymentFeedback(api, profile),
      notify = vi.fn();
    reportDeploymentIssue(api, old, { title: "Old failure" }, notify);
    expect(notify).toHaveBeenCalledOnce();
    expect(feedbackForRequest(state, current)?.state).toBe("running");
  });
  it("warnings and file failures remain separate from successful deployment", () => {
    const { api, state, mount } = fixture();
    mount();
    const request = startDeploymentFeedback(api, profile);
    const files = [{ source: "mod", relPath: "locked", outputPath: "/game/locked" }];
    reportDeploymentIssue(
      api,
      request,
      {
        title: "Some files could not be deployed",
        warning: true,
        options: { allowReport: false },
        files,
      },
      vi.fn(),
    );
    expect(feedbackForRequest(state, request)).toMatchObject({
      state: "failed",
      warning: true,
      files,
    });
    expect(finishDeploymentFeedback(api, request, { state: "deployed" })).toBe(false);
  });
});

describe("deployment error description and fallback", () => {
  for (const shape of ["Error", "array", "nested"] as const) {
    it("formats " + shape + " diagnostics only once before notification telemetry", () => {
      vi.mocked(recordErrorSpan).mockClear();
      const { api, state } = fixture();
      const request = startDeploymentFeedback(api, profile);
      const err = Object.assign(new Error("raw"), { Reason: "failed" });
      const original = err.message;
      const details =
        shape === "array" ? [err] : shape === "nested" ? { error: err, message: "Context" } : err;
      const dispatch = vi.fn();
      const notify = vi.fn(() => {
        expect(err.message).toBe(original);
        showError(dispatch, "Failed", details);
      });
      reportDeploymentIssue(api, request, { title: "Failed", details }, notify);
      expect(notify).toHaveBeenCalledOnce();
      expect(recordErrorSpan).toHaveBeenCalledOnce();
      const description = feedbackForRequest(state, request)?.error;
      expect(description?.content.text).not.toContain("Reason:\tfailed\nReason:\tfailed");
      if (shape === "Error") expect(err.message).toBe("raw\nReason:\tfailed");
    });
  }
  it("retains a warning supplied through error options", () => {
    vi.mocked(recordErrorSpan).mockClear();
    const { api, state, mount } = fixture();
    mount();
    const request = startDeploymentFeedback(api, profile);
    reportDeploymentIssue(
      api,
      request,
      { title: "Warning", details: new Error("warning"), options: { warning: true } },
      vi.fn(),
    );
    expect(feedbackForRequest(state, request)?.warning).toBe(true);
    expect(recordErrorSpan).not.toHaveBeenCalled();
  });
});

describe("real branded error descriptions", () => {
  for (const visible of [false, true]) {
    it("reads real HTTPError private accessors, visible=" + visible, () => {
      vi.mocked(recordErrorSpan).mockClear();
      const { api, state, mount } = fixture();
      if (visible) mount();
      const request = startDeploymentFeedback(api, profile);
      const details = new HTTPError(500, "server", "https://example.test/mod");
      const message = details.message;
      const notify = vi.fn(() => showError(vi.fn(), "Failed", details));
      expect(() =>
        reportDeploymentIssue(api, request, { title: "Failed", details }, notify),
      ).not.toThrow();
      expect(details.statusCode).toBe(500);
      expect(details.message).toBe(message);
      expect(feedbackForRequest(state, request)?.error?.content.parameters).toMatchObject({
        statusCode: 500,
        url: "https://example.test/mod",
      });
      expect(recordErrorSpan).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(visible ? 0 : 1);
    });
  }
  it("retains the real stalled error's nonreportable diagnostic", () => {
    vi.mocked(recordErrorSpan).mockClear();
    const { api, state, mount } = fixture();
    mount();
    const request = startDeploymentFeedback(api, profile);
    reportDeploymentIssue(
      api,
      request,
      { title: "Failed", details: new StalledError("test archive") },
      vi.fn(),
    );
    expect(feedbackForRequest(state, request)?.error?.content.message).toBe("Download stalled");
    expect(recordErrorSpan).not.toHaveBeenCalled();
  });
});
