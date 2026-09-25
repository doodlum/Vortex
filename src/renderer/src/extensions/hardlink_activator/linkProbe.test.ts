/**
 * Tests for the hard link canary probe: same verdict as the uncached probe, and a directory that
 * just passed is not re-probed with synchronous file IO on every isSupported call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canHardlinkIn,
  type ILinkProbeOps,
  LINK_PROBE_TTL_MS,
  resetLinkProbeCache,
} from "./linkProbe";

vi.mock("../../logging", () => ({ log: vi.fn() }));
vi.mock("../../util/fs", () => ({}));

function makeOps(linkError?: string): ILinkProbeOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    writeFileSync: (p) => {
      calls.push(`write ${p}`);
    },
    linkSync: (_src, dest) => {
      calls.push(`link ${dest}`);
      if (linkError !== undefined) {
        throw Object.assign(new Error(linkError), { code: linkError });
      }
    },
    removeSync: (p) => {
      calls.push(`remove ${p}`);
    },
    removeAsync: () => Promise.resolve(),
  };
}

const linkCalls = (ops: { calls: string[] }) =>
  ops.calls.filter((c) => c.startsWith("link")).length;

describe("canHardlinkIn", () => {
  beforeEach(() => resetLinkProbeCache());

  it("reports support when the canary links, and cleans the canary up", () => {
    const ops = makeOps();
    expect(canHardlinkIn("D:\\staging", ops, 0)).toBe(true);
    expect(linkCalls(ops)).toBe(1);
    expect(ops.calls.filter((c) => c.startsWith("remove")).length).toBe(3);
  });

  it("reports no support when linking fails", () => {
    expect(canHardlinkIn("D:\\staging", makeOps("EISDIR"), 0)).toBe(false);
  });

  it("treats EMFILE as supported, as before", () => {
    expect(canHardlinkIn("D:\\staging", makeOps("EMFILE"), 0)).toBe(true);
  });

  it("reuses a recent success instead of touching the disk again", () => {
    const ops = makeOps();
    for (let i = 0; i < 50; ++i) {
      expect(canHardlinkIn("D:\\staging", ops, i * 100)).toBe(true);
    }
    expect(linkCalls(ops)).toBe(1);
  });

  it("re-probes once the success is older than the TTL", () => {
    const ops = makeOps();
    canHardlinkIn("D:\\staging", ops, 0);
    canHardlinkIn("D:\\staging", ops, LINK_PROBE_TTL_MS);
    expect(linkCalls(ops)).toBe(2);
  });

  it("probes each directory separately", () => {
    const ops = makeOps();
    canHardlinkIn("D:\\staging", ops, 0);
    expect(canHardlinkIn("E:\\staging", makeOps("EXDEV"), 0)).toBe(false);
    canHardlinkIn("D:\\staging", ops, 1);
    expect(linkCalls(ops)).toBe(1);
  });

  it("never caches a failure or an inconclusive (EMFILE) probe", () => {
    const failing = makeOps("EISDIR");
    canHardlinkIn("D:\\staging", failing, 0);
    canHardlinkIn("D:\\staging", failing, 1);
    expect(linkCalls(failing)).toBe(2);

    const busy = makeOps("EMFILE");
    canHardlinkIn("E:\\staging", busy, 0);
    canHardlinkIn("E:\\staging", busy, 1);
    expect(linkCalls(busy)).toBe(2);
  });

  it("notices a directory that stops working after the TTL", () => {
    canHardlinkIn("D:\\staging", makeOps(), 0);
    expect(canHardlinkIn("D:\\staging", makeOps("EISDIR"), LINK_PROBE_TTL_MS)).toBe(false);
    // and the failure dropped the success, so the next call probes again
    const ops = makeOps();
    canHardlinkIn("D:\\staging", ops, LINK_PROBE_TTL_MS + 1);
    expect(linkCalls(ops)).toBe(1);
  });
});
