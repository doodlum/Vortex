/**
 * The hard link deployment method's isSupported, as getCurrentActivator/allTypesSupported call it:
 * once per mod type, on every call. Separate calls answer exactly as before (every check, including
 * the canary link, runs each time), while one getCurrentActivator call links the canary once for
 * the staging folder instead of once per type per support check.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  constants: { W_OK: 2 },
  accessSync: vi.fn(),
  statSync: vi.fn((p: string) => ({ dev: p.startsWith("E:") ? 2 : 1 })),
  writeFileSync: vi.fn(),
  linkSync: vi.fn(),
  removeSync: vi.fn(),
  removeAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../util/fs", () => fsMock);
vi.mock("../../logging", () => ({ log: vi.fn() }));
vi.mock("winapi-bindings", () => ({}));
vi.mock("turbowalk", () => ({ default: vi.fn() }));
vi.mock("../../util/selectors", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installPathForGame: (state: any) => state.stagingPath,
}));
vi.mock("../gamemode_management/util/getGame", () => ({
  getGame: () => ({
    getModPaths: () => ({ "": "D:\\game\\Data", root: "D:\\game", enb: "D:\\game" }),
  }),
}));

import type { IDeploymentMethod } from "../mod_management/types/IDeploymentMethod";
import allTypesSupported from "../mod_management/util/allTypesSupported";
import {
  getCurrentActivator,
  registerDeploymentMethod,
} from "../mod_management/util/deploymentMethods";
import init from "./index";

function makeActivator(): IDeploymentMethod {
  let activator: IDeploymentMethod;
  init({
    api: {},
    registerDeploymentMethod: (act: IDeploymentMethod) => {
      activator = act;
    },
  } as any);
  return activator;
}

const state = (stagingPath: string) =>
  ({
    stagingPath,
    settings: {
      gameMode: { discovered: { fallout4: { path: "D:\\game" } } },
      mods: { activator: {} },
    },
  }) as any;

describe("hardlink isSupported", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports all types on a linkable same-drive staging folder", () => {
    const result = allTypesSupported(makeActivator(), state("D:\\staging"), "fallout4", [
      "",
      "root",
      "enb",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("still links the canary on every separate support check", () => {
    const activator = makeActivator();
    for (let i = 0; i < 20; ++i) {
      allTypesSupported(activator, state("D:\\staging"), "fallout4", ["", "root", "enb"]);
    }
    expect(fsMock.linkSync).toHaveBeenCalledTimes(60);
    expect(fsMock.accessSync).toHaveBeenCalledTimes(60);
  });
  it("still rejects a staging folder on another drive without a canary", () => {
    const result = allTypesSupported(makeActivator(), state("E:\\staging"), "fallout4", [""]);
    expect(result.errors).toHaveLength(1);
    expect(fsMock.linkSync).not.toHaveBeenCalled();
  });

  it("still rejects a filesystem that refuses the link", () => {
    fsMock.linkSync.mockImplementation(() => {
      throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    });
    const activator = makeActivator();
    const first = allTypesSupported(activator, state("D:\\staging"), "fallout4", [""]);
    const second = allTypesSupported(activator, state("D:\\staging"), "fallout4", [""]);
    expect(first.errors).toHaveLength(1);
    expect(second.errors).toHaveLength(1);
    fsMock.linkSync.mockReset();
  });
});

describe("getCurrentActivator with the hard link method", () => {
  let hardlink: IDeploymentMethod;
  beforeAll(() => {
    hardlink = makeActivator();
    registerDeploymentMethod(hardlink);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.linkSync.mockReset();
  });

  it("links the canary once per call instead of once per type per check", () => {
    for (let i = 0; i < 20; ++i) {
      expect(getCurrentActivator(state("D:\\staging"), "fallout4", true)).toBe(hardlink);
    }
    // unshared: 3 types for the default search + 3 for the re-check, per call = 120
    expect(fsMock.linkSync).toHaveBeenCalledTimes(20);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(20);
    // the other checks still run for every type
    expect(fsMock.accessSync).toHaveBeenCalledTimes(120);
  });

  it("notices on the very next call that the folder stopped linking, and started again", () => {
    expect(getCurrentActivator(state("D:\\staging"), "fallout4", true)).toBe(hardlink);
    fsMock.linkSync.mockImplementation(() => {
      throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    });
    expect(getCurrentActivator(state("D:\\staging"), "fallout4", true)).toBeUndefined();
    fsMock.linkSync.mockReset();
    expect(getCurrentActivator(state("D:\\staging"), "fallout4", true)).toBe(hardlink);
  });

  it("re-probes within a call after an inconclusive EMFILE, as before", () => {
    fsMock.linkSync.mockImplementation(() => {
      throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    });
    expect(getCurrentActivator(state("D:\\staging"), "fallout4", true)).toBe(hardlink);
    expect(fsMock.linkSync).toHaveBeenCalledTimes(6);
  });

  it("rejects another drive without a canary", () => {
    expect(getCurrentActivator(state("E:\\staging"), "fallout4", true)).toBeUndefined();
    expect(fsMock.linkSync).not.toHaveBeenCalled();
  });
});
