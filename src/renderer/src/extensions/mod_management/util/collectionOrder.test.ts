import { describe, expect, it } from "vitest";

import { makeMod, makeReference, makeRule } from "../../../test-utils/builders";
import type { IMod } from "../types/IMod";
import { orderCollectionMembers } from "./collectionOrder";

const member = (id: string, tag?: string): IMod =>
  makeMod({ id, attributes: tag !== undefined ? { referenceTag: tag } : {} });

const collection = (id: string, tags: string[]): IMod =>
  makeMod({
    id,
    type: "collection",
    rules: tags.map((tag) => makeRule({ type: "requires", reference: makeReference({ tag }) })),
  });

const byId = (mods: IMod[]) => Object.fromEntries(mods.map((mod) => [mod.id, mod]));
const ids = (mods: IMod[]) => mods.map((mod) => mod.id);

describe("orderCollectionMembers", () => {
  it("orders members as the collection lists them, whatever order their installs started", () => {
    const coll = collection("coll", ["t-a", "t-b", "t-c"]);
    const a = member("a", "t-a");
    const b = member("b", "t-b");
    const c = member("c", "t-c");
    const all = byId([coll, a, b, c]);
    expect(ids(orderCollectionMembers([c, a, b], all))).toEqual(["a", "b", "c"]);
    expect(ids(orderCollectionMembers([b, c, a], all))).toEqual(["a", "b", "c"]);
  });

  it("leaves every other mod where it was", () => {
    const coll = collection("coll", ["t-a", "t-b"]);
    const a = member("a", "t-a");
    const b = member("b", "t-b");
    const x = member("x");
    const y = member("y", "unrelated");
    const all = byId([coll, a, b, x, y]);
    expect(ids(orderCollectionMembers([x, b, coll, y, a], all))).toEqual([
      "x",
      "a",
      "coll",
      "y",
      "b",
    ]);
  });

  it("returns the input untouched without collections", () => {
    const mods = [member("b", "t-b"), member("a", "t-a")];
    expect(orderCollectionMembers(mods, byId(mods))).toBe(mods);
  });

  it("uses the collection with the lowest id for a mod listed by two", () => {
    const first = collection("coll-1", ["t-b", "t-a"]);
    const second = collection("coll-2", ["t-a", "t-b"]);
    const a = member("a", "t-a");
    const b = member("b", "t-b");
    const all = byId([second, first, a, b]);
    expect(ids(orderCollectionMembers([a, b], all))).toEqual(["b", "a"]);
  });
});
