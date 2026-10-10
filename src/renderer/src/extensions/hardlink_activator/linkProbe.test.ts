/**
 * Tests for the hard link canary probe: every call answers exactly as an unshared probe would,
 * and only calls inside one probe scope share a conclusive answer for the same folder.
 */

import * as nativeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { log } from "../../logging";
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

describe("native canary cleanup", () => {
  it("shares a real hardlink probe and leaves no files behind", () => {
    const folder = nativeFs.mkdtempSync(path.join(os.tmpdir(), "vortex-probe-"));
    let links = 0;
    const ops: ILinkProbeOps = {
      writeFileSync: nativeFs.writeFileSync,
      linkSync: (source, target) => {
        nativeFs.linkSync(source, target);
        links++;
        expect(nativeFs.statSync(source).ino).toBe(nativeFs.statSync(target).ino);
      },
      removeSync: (file) => nativeFs.rmSync(file, { force: true }),
      removeAsync: (file) => nativeFs.promises.rm(file, { force: true }),
    };
    try {
      withProbeScope(() => {
        expect(canHardlinkIn(folder, ops)).toBe(true);
        expect(canHardlinkIn(folder, ops)).toBe(true);
      });
      expect(links).toBe(1);
      expect(nativeFs.readdirSync(folder)).toEqual([]);
      expect(canHardlinkIn(folder, ops)).toBe(true);
      expect(links).toBe(2);
      expect(nativeFs.readdirSync(folder)).toEqual([]);
    } finally {
      expect(path.dirname(path.resolve(folder))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(folder).startsWith("vortex-probe-")).toBe(true);
      nativeFs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "settles delayed cleanup and reports a rejection (reject=%s)",
    async (reject) => {
      vi.useFakeTimers();
      const ops = makeOps();
      let removals = 0;
      ops.removeSync = () => {
        if (++removals === 2) throw Object.assign(new Error("held"), { code: "EBUSY" });
      };
      const error = new Error("cleanup refused");
      ops.removeAsync = vi.fn(() => (reject ? Promise.reject(error) : Promise.resolve()));
      vi.mocked(log).mockClear();
      try {
        expect(probeHardlink("D:\\staging", ops)).toBe("linked");
        await vi.runAllTimersAsync();
        expect(ops.removeAsync).toHaveBeenCalledTimes(reject ? 1 : 2);
        if (reject)
          expect(log).toHaveBeenCalledWith(
            "error",
            expect.stringContaining("failed to clean up canary"),
            expect.objectContaining({ message: error.message }),
          );
        else expect(log).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

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
