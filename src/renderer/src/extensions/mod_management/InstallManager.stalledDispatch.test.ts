import { describe, expect, vi } from "vitest";

import { markSessionStalled } from "../../actions/collectionInstallTracking";
import { makeInstallState, makeMod, makeProfile, makeSession } from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { generateCollectionSessionId } from "../../util/collectionInstallSession";

vi.mock("../../util/log", () => ({ log: vi.fn() }));

describe("dependency install stalled marker", () => {
  for (const active of ["same", "other", "none"] as const) {
    test(`only resets the matching active session (${active})`, async ({ makeInstallManager }) => {
      const profile = makeProfile({ id: "prof1", gameId: "skyrimse" });
      const sessionId = generateCollectionSessionId("collection", profile.id);
      const session =
        active === "none"
          ? undefined
          : makeSession({
              sessionId: active === "same" ? sessionId : "other-session",
              stalled: true,
            });
      const h = makeInstallManager({
        mods: { skyrimse: { collection: makeMod({ id: "collection", rules: [] }) } },
        profiles: { prof1: profile },
        session: makeInstallState({ activeSession: session }),
      });
      // The real entry point and Redux reset run; the asynchronous dependency pipeline is outside this assertion.
      vi.spyOn(h.manager as any, "installDependenciesImpl").mockResolvedValue(undefined);
      await h.manager.installDependencies(h.api, profile, "skyrimse", "collection", true, false);
      expect(h.dispatched.filter((action) => action.type === markSessionStalled.getType())).toEqual(
        active === "same" ? [markSessionStalled(sessionId, false)] : [],
      );
      expect(h.getState().session.collections.activeSession?.stalled).toBe(
        active === "same" ? false : active === "other" ? true : undefined,
      );
    });
  }
});
