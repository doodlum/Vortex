/**
 * Tests for the hard link canary probe: every call answers exactly as an unshared probe would,
 * and only calls inside one probe scope share a conclusive answer for the same folder.
 */

import { describe, expect, it, vi } from "vitest";

import { withProbeScope } from "../mod_management/util/probeScope";
import { canHardlinkIn, type ILinkProbeOps, probeHardlink } from "./linkProbe";

vi.mock("../../logging", () => ({ log: vi.fn() }));
vi.mock("../../util/fs", () => ({}));

/** ops whose link outcome for each successive probe is taken from `outcomes` (undefined = ok) */
function makeOps(...outcomes: Array<string | undefined>): ILinkProbeOps & { calls: string[] } {
  const calls: string[] = [];
  let probe = 0;
  return {
    calls,
    writeFileSync: (p) => {
      calls.push(`write ${p}`);
    },
    linkSync: (_src, dest) => {
      calls.push(`link ${dest}`);
      const code = outcomes[Math.min(probe++, outcomes.length - 1)];
      if (code !== undefined) {
        throw Object.assign(new Error(code), { code });
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

const OUTCOMES = [undefined, "EISDIR", "EXDEV", "EMFILE"];

describe("probeHardlink", () => {
  it("classifies every exit path and cleans the canary up", () => {
    expect(probeHardlink("D:\\staging", makeOps())).toBe("linked");
    expect(probeHardlink("D:\\staging", makeOps("EISDIR"))).toBe("refused");
    expect(probeHardlink("D:\\staging", makeOps("EMFILE"))).toBe("inconclusive");
    const ops = makeOps();
    probeHardlink("D:\\staging", ops);
    expect(ops.calls.filter((c) => c.startsWith("remove")).length).toBe(3);
  });
});

describe("canHardlinkIn", () => {
  it("gives the old verdicts: linked and EMFILE are supported, a refusal is not", () => {
    expect(canHardlinkIn("D:\\staging", makeOps())).toBe(true);
    expect(canHardlinkIn("D:\\staging", makeOps("EISDIR"))).toBe(false);
    expect(canHardlinkIn("D:\\staging", makeOps("EMFILE"))).toBe(true);
  });

  it("probes on every call outside a scope, so a changed outcome is seen at once", () => {
    for (const first of OUTCOMES) {
      for (const second of OUTCOMES) {
        const ops = makeOps(first, second);
        expect(canHardlinkIn("D:\\staging", ops)).toBe(first !== "EISDIR" && first !== "EXDEV");
        expect(canHardlinkIn("D:\\staging", ops)).toBe(second !== "EISDIR" && second !== "EXDEV");
        expect(linkCalls(ops)).toBe(2);
      }
    }
  });

  it("does not carry anything from one scope into the next", () => {
    for (const first of OUTCOMES) {
      for (const second of OUTCOMES) {
        const ops = makeOps(first, second);
        const a = withProbeScope(() => canHardlinkIn("D:\\staging", ops));
        const b = withProbeScope(() => canHardlinkIn("D:\\staging", ops));
        const reference = makeOps(first, second);
        expect([a, b]).toEqual([
          canHardlinkIn("D:\\staging", reference),
          canHardlinkIn("D:\\staging", reference),
        ]);
        expect(linkCalls(ops)).toBe(2);
      }
    }
  });

  it("shares a conclusive answer for the same folder within one scope", () => {
    for (const outcome of [undefined, "EISDIR"]) {
      const ops = makeOps(outcome);
      const results = withProbeScope(() =>
        [1, 2, 3, 4, 5, 6].map(() => canHardlinkIn("D:\\staging", ops)),
      );
      expect(results).toEqual(new Array(6).fill(outcome === undefined));
      expect(linkCalls(ops)).toBe(1);
    }
  });

  it("re-probes after an inconclusive answer within a scope", () => {
    const ops = makeOps("EMFILE", undefined);
    withProbeScope(() => {
      expect(canHardlinkIn("D:\\staging", ops)).toBe(true);
      expect(canHardlinkIn("D:\\staging", ops)).toBe(true);
      expect(canHardlinkIn("D:\\staging", ops)).toBe(true);
    });
    expect(linkCalls(ops)).toBe(2);
  });

  it("probes each folder separately within a scope, and nested scopes join the outer one", () => {
    const ops = makeOps();
    withProbeScope(() => {
      canHardlinkIn("D:\\staging", ops);
      canHardlinkIn("E:\\staging", ops);
      withProbeScope(() => canHardlinkIn("D:\\staging", ops));
    });
    expect(linkCalls(ops)).toBe(2);
  });

  it("closes the scope when the scoped function throws", () => {
    const ops = makeOps();
    expect(() =>
      withProbeScope(() => {
        canHardlinkIn("D:\\staging", ops);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    canHardlinkIn("D:\\staging", ops);
    expect(linkCalls(ops)).toBe(2);
  });
});
