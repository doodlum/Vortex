import { batch } from "redux-act";
import { describe, expect, it } from "vitest";

import { setModAttributes, setModType } from "./actions/mods";
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
