/**
 * The hard link deployment method's isSupported, as getCurrentActivator/allTypesSupported call it:
 * once per mod type, on every call. The canary link test must run once for the staging folder,
 * not once per type per call, while write access and the same-drive check still run every time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import init from "./index";
import { resetLinkProbeCache } from "./linkProbe";

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
    settings: { gameMode: { discovered: { fallout4: { path: "D:\\game" } } } },
  }) as any;

describe("hardlink isSupported", () => {
  beforeEach(() => {
    resetLinkProbeCache();
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

  it("links the canary once across repeated calls for every mod type", () => {
    const activator = makeActivator();
    for (let i = 0; i < 20; ++i) {
      allTypesSupported(activator, state("D:\\staging"), "fallout4", ["", "root", "enb"]);
    }
    expect(fsMock.linkSync).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    // the cheap checks still run on every call, so losing write access is noticed at once
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
