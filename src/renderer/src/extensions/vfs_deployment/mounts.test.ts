import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  sessions: [] as Array<{ given: unknown[]; started: boolean; closed: boolean }>,
  failNext: false,
}));

vi.mock("../../util/getVortexPath", () => ({ default: () => "/tmp/vortex" }));
vi.mock("./aether", () => ({
  aetherErrorCode: () => "E_MOUNT",
  loadAether: () => ({
    dir: "/opt/aether",
    createSession: (_stateDir: string, roots: unknown[]) => {
      const session = {
        given: roots,
        started: false,
        closed: false,
        start: () => {
          if (fakes.failNext) {
            fakes.failNext = false;
            throw new Error("E_MOUNT: fusermount3 failed");
          }
          session.started = true;
        },
        close: () => {
          session.closed = true;
        },
        roots: () => [],
        mounted: () => [0],
      };
      fakes.sessions.push(session);
      return session;
    },
  }),
}));
vi.mock("./roots", () => ({
  deploymentForGame: () =>
    Promise.resolve({ gamePath: "/games/x", stagingPath: "/staging", deployments: [] }),
  gameRoots: () => [{ location: "/games/x", files: [] }],
}));

import type { IExtensionApi } from "../../types/IExtensionContext";
import { isMounted, mountGame, unmountAll, unmountGame } from "./mounts";

const platform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "linux" }));
afterAll(() => Object.defineProperty(process, "platform", { value: platform }));

describe("the Linux mounts", () => {
  const errors: unknown[] = [];
  const api = {
    showErrorNotification: (...args: unknown[]) => errors.push(args),
  } as unknown as IExtensionApi;

  it("mounts a game, replaces its mount on the next mount and unmounts it", async () => {
    await mountGame(api, "x");
    expect(isMounted("x")).toBe(true);
    expect(fakes.sessions[0].started).toBe(true);
    await mountGame(api, "x");
    expect(fakes.sessions[0].closed).toBe(true);
    expect(fakes.sessions[1].started).toBe(true);
    unmountGame("x");
    expect(isMounted("x")).toBe(false);
    expect(fakes.sessions[1].closed).toBe(true);
  });

  it("reports a mount that fails and keeps nothing mounted", async () => {
    fakes.failNext = true;
    await mountGame(api, "y");
    expect(isMounted("y")).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("unmounts everything when Vortex closes", async () => {
    await mountGame(api, "a");
    await mountGame(api, "b");
    unmountAll();
    expect(isMounted("a") || isMounted("b")).toBe(false);
  });
});
