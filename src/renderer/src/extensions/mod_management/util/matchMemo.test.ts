/**
 * The compiled-glob and sanitized-name memos behind reference matching must not change a single
 * answer. These tests compare the memoised matcher against plain minimatch, and findModByRef /
 * testModReference against the same modules loaded with the memos replaced by the unmemoised
 * calls they stand for, over randomised mods and references. The work-count test pins the
 * saving: a scan compiles each distinct fileExpression once, not once per (mod, reference).
 */

import minimatch from "minimatch";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMod, IModReference } from "../types/IMod";
import { findModByRef } from "./findModByRef";
import { globMatch } from "./matchMemo";
import { testModReference, testRefByIdentifiers } from "./testModReference";

vi.mock("../../../util/log", () => ({ log: vi.fn() }));

// deterministic PRNG so a failure reproduces
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["Armor", "armor", "Mod", "Patch", "Big Guns", "UI", "x", "a.b", "1.2", "Ünï", "(1)"];
const SUFFIXES = ["", ".7z", ".zip", ".1.7z", " (1).rar", ".tar.gz", "-123-1-0.7z", "."];

function makeName(r: () => number): string {
  const n = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(WORDS[Math.floor(r() * WORDS.length)]);
  }
  return parts.join(r() < 0.5 ? " " : "-") + SUFFIXES[Math.floor(r() * SUFFIXES.length)];
}

const PATTERN_EDGES = [
  "",
  "   ",
  "#Armor",
  " #Armor",
  "!Armor*",
  "!!Armor*",
  "*",
  "**",
  "?",
  "Armor*",
  "*Patch*",
  "{Armor,Mod}*",
  "Armor?Mod",
  "[A-M]*",
  "[!A]*",
  "+(Armor|Mod)*",
  "@(UI|x)",
  "a\\.b*",
  "Big Guns",
  "Bundled - x?*",
  "a/b",
  "*/",
  "\\*",
  "Ünï*",
];

function makePattern(r: () => number): string {
  if (r() < 0.4) {
    return PATTERN_EDGES[Math.floor(r() * PATTERN_EDGES.length)];
  }
  const base = makeName(r).replace(/\.[^.]*$/, "");
  const chars = base.split("");
  const k = Math.floor(r() * 3);
  for (let i = 0; i < k && chars.length > 0; i++) {
    const at = Math.floor(r() * chars.length);
    chars[at] = ["*", "?", "[a-z]", "{a,b}"][Math.floor(r() * 4)];
  }
  return chars.join("");
}

function outcome(fn: () => unknown): unknown {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : typeof err };
  }
}

// One copy of the modules. `mode.memo` picks what their matchMemo import does: the real memos, or
// the calls they stand for, minimatch(name, expr) and sanitize(fileName) - the pre-change path.
const mode = vi.hoisted(() => ({ memo: true }));
vi.mock("./matchMemo", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  const plain = (await import("minimatch")).default;
  return {
    globMatch: (name: string, expression: string) =>
      mode.memo ? real.globMatch(name, expression) : plain(name, expression),
    sanitizedFileName: (name: string, sanitize: (n: string) => string) =>
      mode.memo ? real.sanitizedFileName(name, sanitize) : sanitize(name),
  };
});

function withMemo<T>(memo: boolean, fn: () => T): T {
  const before = mode.memo;
  mode.memo = memo;
  try {
    return fn();
  } finally {
    mode.memo = before;
  }
}

function makeMods(r: () => number, count: number): { [id: string]: IMod } {
  const mods: { [id: string]: IMod } = {};
  const md5s = ["m1", "m2", "m3", undefined];
  for (let i = 0; i < count; i++) {
    const id = `mod${i}`;
    const fileName = r() < 0.9 ? makeName(r) : undefined;
    mods[id] = {
      id,
      state: "installed",
      type: "",
      installationPath: id,
      attributes: {
        fileName,
        name: r() < 0.5 ? makeName(r) : undefined,
        logicalFileName: r() < 0.6 ? makeName(r) : undefined,
        fileMD5: md5s[Math.floor(r() * md5s.length)],
        version: ["1.0.0", "1.2", "2.0.0-beta", "v3", "", undefined][Math.floor(r() * 6)],
        source: r() < 0.5 ? "nexus" : undefined,
        modId: r() < 0.5 ? Math.floor(r() * 3) : undefined,
        fileId: r() < 0.5 ? Math.floor(r() * 3) : undefined,
        referenceTag: r() < 0.2 ? `tag${Math.floor(r() * 3)}` : undefined,
        game: r() < 0.5 ? ["fallout4"] : undefined,
      },
    };
  }
  return mods;
}

function makeRef(r: () => number): IModReference {
  const ref: IModReference = {};
  if (r() < 0.7) ref.fileExpression = makePattern(r);
  if (r() < 0.3) ref.logicalFileName = makeName(r);
  if (r() < 0.3) ref.fileMD5 = ["m1", "m2", "x"][Math.floor(r() * 3)];
  if (r() < 0.5)
    ref.versionMatch = ["*", "1.0.0", ">=1.0.0", "^1.0.0", "2.0.0-beta", "~1.2"][
      Math.floor(r() * 6)
    ];
  if (r() < 0.2) ref.tag = `tag${Math.floor(r() * 3)}`;
  if (r() < 0.2) {
    ref.repo = {
      repository: "nexus",
      gameId: "fallout4",
      modId: String(Math.floor(r() * 3)),
      fileId: String(Math.floor(r() * 3)),
    };
  }
  if (r() < 0.1) ref.idHint = `mod${Math.floor(r() * 40)}`;
  if (r() < 0.1) ref.gameId = "fallout4";
  return ref;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("globMatch", () => {
  it("answers exactly as minimatch for random and edge-case names and patterns, repeatedly", () => {
    const r = rng(1);
    const names = Array.from({ length: 150 }, () => makeName(r)).concat(["", "/", "a/b", "#x"]);
    const patterns = Array.from({ length: 150 }, () => makePattern(r)).concat(PATTERN_EDGES);
    // two passes: the second answers from compiled patterns
    for (let pass = 0; pass < 2; pass++) {
      for (const pattern of patterns) {
        for (const name of names) {
          expect(outcome(() => globMatch(name, pattern))).toEqual(
            outcome(() => minimatch(name, pattern)),
          );
        }
      }
    }
  });

  it("throws on an invalid pattern every time, as minimatch does", () => {
    for (const bad of [undefined, null, 42, "x".repeat(70000)] as any[]) {
      for (let pass = 0; pass < 2; pass++) {
        expect(outcome(() => globMatch("x", bad))).toEqual(outcome(() => minimatch("x", bad)));
      }
    }
  });
});

describe("findModByRef with memoised matching", () => {
  it("returns the same mod, in the same order, as the unmemoised matcher", () => {
    let found = 0;
    let globHits = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const mods = makeMods(r, 40);
      const refs = Array.from({ length: 60 }, () => makeRef(r));
      for (const ref of refs) {
        const find = () => outcome(() => findModByRef({ ...ref }, mods)?.id);
        const expected = withMemo(false, find);
        expect(withMemo(true, find)).toEqual(expected);
        if ((expected as { value?: string }).value !== undefined) {
          found += 1;
          if (ref.fileExpression !== undefined && ref.repo === undefined && ref.tag === undefined) {
            globHits += 1;
          }
        }
        for (const mod of Object.values(mods)) {
          const test = () => testModReference(mod, ref);
          expect(withMemo(true, test)).toBe(withMemo(false, test));
        }
        const identifiers = {
          gameId: "fallout4",
          fileNames: Object.values(mods)
            .slice(0, 3)
            .map((mod) => mod.attributes.fileName)
            .filter((name) => name !== undefined),
        };
        const byIds = () => testRefByIdentifiers(identifiers, ref);
        expect(withMemo(true, byIds)).toBe(withMemo(false, byIds));
      }
    }
    // the inputs exercise real matches, including ones decided by the glob
    expect(found).toBeGreaterThan(50);
    expect(globHits).toBeGreaterThan(10);
  });
});

describe("findModByRef work", () => {
  // Any pattern compile, from minimatch() or new Minimatch(), goes through Minimatch.prototype.make.
  function compilesForScan(memo: boolean): number {
    const r = rng(7);
    const mods: { [id: string]: IMod } = {};
    for (let i = 0; i < 200; i++) {
      mods[`m${i}`] = {
        id: `m${i}`,
        state: "installed",
        type: "",
        installationPath: `m${i}`,
        attributes: { fileName: `${makeName(r)}.7z`, version: "1.0.0" },
      };
    }
    // 50 references over 10 distinct glob expressions, none of which matches
    const refs = Array.from({ length: 50 }, (_v, i) => ({ fileExpression: `nomatch${i % 10}*` }));
    const make = vi.spyOn(minimatch.Minimatch.prototype, "make");
    for (const ref of refs) {
      expect(withMemo(memo, () => findModByRef(ref, mods))).toBeUndefined();
    }
    const count = make.mock.calls.length;
    make.mockRestore();
    return count;
  }

  it("compiles each distinct fileExpression at most once per scan", () => {
    expect(compilesForScan(true)).toBeLessThanOrEqual(10);
  });

  it("control: the unmemoised matcher compiles once per (mod, reference)", () => {
    // Shows the count above is measuring the saving: without the memo, 200 x 50 compiles.
    expect(compilesForScan(false)).toBe(200 * 50);
  });
});
