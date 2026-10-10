import { batch } from "redux-act";
import { describe, expect, it } from "vitest";

import ReduxWatcher from "../../store/ReduxWatcher";
import { makeApiHarness, makeMod, makeProfile } from "../../test-utils/builders";
import { setDeploymentNecessary } from "./actions/deployment";
import { setModAttributes, setModType } from "./actions/mods";
import { onModsChanged } from "./eventHandlers";
import InstallManager from "./InstallManager";

// applyExtraFromRule used to dispatch setModType and then setModAttributes. It now dispatches
// them as one batch. The actions, their order and so the resulting state must be unchanged.
const flatten = (actions: any[]): any[] =>
  actions.flatMap((a) => (a.type === batch.getType() ? a.payload : [a]));

const run = (extra: any) => {
  const dispatched: any[] = [];
  const api: any = {
    store: { dispatch: (a: any) => dispatched.push(a) },
    getState: () => ({ persistent: { categories: {} } }),
  };
  (InstallManager.prototype as any).applyExtraFromRule.call({}, api, "fallout4", "m1", extra);
  return dispatched;
};

describe("applyExtraFromRule batching", () => {
  it.each([false, true])(
    "preserves real state and type-change signaling with installing=%s",
    (installing) => {
      const seed = {
        mods: { skyrimse: { m1: makeMod({ id: "m1" }) } },
        profiles: { prof1: makeProfile({ id: "prof1", gameId: "skyrimse" }) },
        activeProfileId: "prof1",
      };
      const h = makeApiHarness(seed);
      const legacy = makeApiHarness(seed);
      if (installing)
        h.setState((state) => {
          Object.assign(state.session, {
            base: { activity: { installing_dependencies: ["collection"] } },
          });
        });
      const before = h.getState().persistent.mods;
      const notifications: unknown[] = [];
      const watched: unknown[] = [];
      h.api.store.subscribe(() => notifications.push(h.getState().persistent.mods));
      const watcher = new ReduxWatcher(h.api.store, (error) => {
        throw error;
      });
      watcher.on(["persistent", "mods"], (change) => watched.push(change.currentValue));
      (InstallManager.prototype as any).applyExtraFromRule.call({}, h.api, "skyrimse", "m1", {
        type: "dinput",
        name: "member",
        version: "1.2",
      });
      legacy.api.store.dispatch(setModType("skyrimse", "m1", "dinput"));
      legacy.api.store.dispatch(
        setModAttributes("skyrimse", "m1", { customFileName: "member", version: "1.2" }),
      );
      expect(h.getState().persistent.mods).toEqual(legacy.getState().persistent.mods);
      expect(notifications).toHaveLength(1);
      expect(watched).toEqual([h.getState().persistent.mods]);
      onModsChanged(h.api, before, h.getState().persistent.mods);
      expect(
        h.dispatched.filter((action) => action.type === setDeploymentNecessary.getType()),
      ).toHaveLength(installing ? 0 : 1);
    },
  );

  it("dispatches the legacy action sequence in one batch when a type is set", () => {
    const extra = { type: "dinput", name: "n", version: "1.2", author: "a", fileList: [] };
    const dispatched = run(extra);
    expect(dispatched).toHaveLength(1);
    expect(flatten(dispatched)).toEqual([
      setModType("fallout4", "m1", "dinput"),
      setModAttributes("fallout4", "m1", {
        customFileName: "n",
        author: "a",
        version: "1.2",
        fileList: [],
      }),
    ]);
  });

  it("negative control: without a type it is a single plain setModAttributes", () => {
    const dispatched = run({ name: "n" });
    expect(dispatched).toEqual([setModAttributes("fallout4", "m1", { customFileName: "n" })]);
    expect(dispatched[0].type).not.toBe(batch.getType());
  });

  it("does nothing without extra", () => {
    expect(run(undefined)).toEqual([]);
  });
});
