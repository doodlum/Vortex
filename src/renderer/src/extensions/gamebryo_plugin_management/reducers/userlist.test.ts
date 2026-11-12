import { describe, expect, it } from "vitest";

import { addRule, removeRule } from "../actions/userlist";
import userlistReducer from "./userlist";

function reduce(state, action) {
  return userlistReducer.reducers[action.type](state, action.payload);
}

describe("conditional userlist references", () => {
  it.each([
    ["after", "after"],
    ["requires", "req"],
    ["incompatible", "inc"],
  ])("removes one %s condition without changing another", (type, list) => {
    const reference = { name: "Other.esp", display: "Other", condition: 'active("A.esp")' };
    const retained = { ...reference, condition: 'active("B.esp")' };
    const state = { plugins: [{ name: "Example.esp", [list]: [reference, retained] }], groups: [] };
    const action = removeRule("EXAMPLE.ESP", { ...reference, name: "OTHER.ESP" }, type);

    expect(() => reduce(state, action)).not.toThrow();
    expect(reduce(state, action).plugins[0][list]).toEqual([retained]);
    expect(state.plugins[0][list]).toEqual([reference, retained]);
  });

  it("matches a plain name to an unconditional object and retains conditional rules", () => {
    const conditional = { name: "Other.esp", display: "Other", condition: 'active("A.esp")' };
    const state = {
      plugins: [
        { name: "Example.esp", after: [{ name: "Other.esp", display: "Other" }, conditional] },
      ],
      groups: [],
    };
    const action = removeRule("example.esp", "OTHER.ESP", "after");

    expect(() => reduce(state, action)).not.toThrow();
    expect(reduce(state, action).plugins[0].after).toEqual([conditional]);
  });

  it("deduplicates equivalent references without dropping a different condition", () => {
    const reference = { name: "Other.esp", display: "Other", condition: 'active("A.esp")' };
    const state = { plugins: [{ name: "Example.esp", after: [reference] }], groups: [] };
    const duplicate = addRule(
      "EXAMPLE.ESP",
      { ...reference, name: "OTHER.ESP", display: "Label" },
      "after",
    );
    expect(reduce(state, duplicate)).toBe(state);
    const distinct = { ...reference, condition: 'active("B.esp")' };
    expect(reduce(state, addRule("Example.esp", distinct, "after")).plugins[0].after).toEqual([
      reference,
      distinct,
    ]);
  });
});
