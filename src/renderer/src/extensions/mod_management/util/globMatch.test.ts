/**
 * globMatch compiles each fileExpression once instead of on every minimatch() call. Matching a
 * collection's members compares the same few patterns against mod after mod, so these tests
 * count pattern compilations through each real call site: a site that went back to calling
 * minimatch() compiles once per comparison and fails them. They also check that globMatch
 * answers exactly as minimatch() does, and that the cache stays bounded.
 */
import minimatch from "minimatch";
import { describe, expect, vi } from "vitest";

import { makeRule } from "../../../test-utils/builders";
import { test } from "../../../test-utils/harnessTest";
import gatherDependencies from "./dependencies";
import testModReference, { globMatch, testRefByIdentifiers } from "./testModReference";
import type { IModLookupInfo } from "./testModReference";

vi.mock("../../../util/log", () => ({ log: vi.fn() }));

/** Every pattern compilation: minimatch() builds a Minimatch per call, as does `new Minimatch`. */
const compiles = vi.hoisted(() => ({ count: 0 }));

vi.mock("minimatch", async (importOriginal) => {
  const actual = ((await importOriginal()) as { default: typeof minimatch }).default;
  class CountingMinimatch extends actual.Minimatch {
    constructor(...args: ConstructorParameters<typeof actual.Minimatch>) {
      super(...args);
      compiles.count++;
    }
  }
  const counting = (...args: Parameters<typeof actual>) => {
    compiles.count++;
    return actual(...args);
  };
  return { default: Object.assign(counting, actual, { Minimatch: CountingMinimatch }) };
});

/** The pattern compilations `run` causes. */
function compilesDuring(run: () => void): number {
  const before = compiles.count;
  run();
  return compiles.count - before;
}

const MEMBERS = 30;

describe("globMatch", () => {
  test("matches exactly as minimatch does", () => {
    const patterns = [
      "Foo*",
      "Foo v1.0.0",
      "#comment",
      "",
      "*.{esp,esm}",
      "Bundled - [AB]*",
      "a/**",
    ];
    const names = [
      "Foo",
      "Foobar",
      "Foo v1.0.0",
      "#comment",
      "",
      "x.esp",
      "Bundled - Alpha",
      "a/b/c",
    ];
    for (const pattern of patterns) {
      for (const name of names) {
        expect(globMatch(name, pattern)).toBe(minimatch(name, pattern));
        // and again, from the cache
        expect(globMatch(name, pattern)).toBe(minimatch(name, pattern));
      }
    }
  });

  test("keeps at most 10,000 patterns, then starts over", () => {
    const sentinel = () => compilesDuring(() => globMatch("x", "sentinel-*"));
    sentinel();
    // add new patterns until the cache empties, which leaves it holding exactly two: the one
    // added last and the sentinel, compiled again
    let added = 0;
    let emptied = false;
    while (!emptied && added <= 10_000) {
      globMatch("x", `filler-${added++}`);
      emptied = sentinel() === 1;
    }
    expect(emptied).toBe(true);
    for (let i = 0; i < 10_000 - 2; i++) {
      globMatch("x", `more-${i}`);
    }
    // full now, and still holding the sentinel
    expect(sentinel()).toBe(0);
    // one more pattern empties it first
    globMatch("x", "one-too-many");
    expect(sentinel()).toBe(1);
    expect(globMatch("sentinel-1", "sentinel-*")).toBe(true);
  });
});

describe("compiling each fileExpression once", () => {
  test("testRefByIdentifiers, matching one reference against many archives", () => {
    // exported to extensions through util/api
    const ref = { fileExpression: "Identifiers Mod-123-*" };
    let matched = 0;
    const count = compilesDuring(() => {
      for (let i = 0; i < MEMBERS; i++) {
        const fileNames = [`Identifiers Mod-${i % 2 === 0 ? 123 : 456}-${i}-1700000000.7z`];
        if (testRefByIdentifiers({ gameId: "g", fileNames }, ref)) matched++;
      }
    });
    expect(matched).toBe(MEMBERS / 2);
    expect(count).toBe(1);
  });

  test("testModReference, matching one reference against many mods", () => {
    const ref = { fileExpression: "Modref Mod-*" };
    let matched = 0;
    const count = compilesDuring(() => {
      for (let i = 0; i < MEMBERS; i++) {
        const fileName = `${i % 2 === 0 ? "Modref" : "Other"} Mod-${i}.7z`;
        if (testModReference({ id: `mod-${i}`, fileName } as IModLookupInfo, ref)) matched++;
      }
    });
    expect(matched).toBe(MEMBERS / 2);
    expect(count).toBe(1);
  });

  test("gatherDependencies, finding members that one lookup already fulfils", async ({
    makeApi,
  }) => {
    // every member's lookup fulfils every other member's reference, which is checked for each
    // pair of members
    const rules = Array.from({ length: MEMBERS }, (_unused, i) =>
      makeRule({
        type: "requires",
        reference: { fileExpression: "Gather Mod-*", tag: `member-${i}` },
      }),
    );
    const h = makeApi();
    Object.assign(h.api, {
      lookupModReference: vi.fn(async () => [{ key: "k", value: { fileName: "Gather Mod-1.7z" } }]),
      lookupModMeta: vi.fn().mockResolvedValue([]),
    });

    const before = compiles.count;
    const deps = await gatherDependencies(rules, h.api, false);

    // one member's download serves them all, so the others are dropped as redundant
    expect(deps).toHaveLength(1);
    expect(compiles.count - before).toBe(1);
  });
});
