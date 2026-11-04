import { setImmediate } from "node:timers/promises";

import PromiseBB from "bluebird";
import { expect, it, vi } from "vitest";

import { settleAll } from "./settleAll";

const NativePromise = (async () => undefined)().constructor as PromiseConstructor;

it.each(["native", "bluebird"] as const)(
  "returns standard ordered outcomes with %s Promise and foreign thenables",
  async (runtime) => {
    const failure = new Error("expected failure");
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    try {
      const result = await settleAll([1, PromiseBB.resolve(2), NativePromise.reject(failure)]);
      expect(result).toEqual([
        { status: "fulfilled", value: 1 },
        { status: "fulfilled", value: 2 },
        { status: "rejected", reason: failure },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
it.each(["native", "bluebird"] as const)(
  "waits for pending work after a rejection with %s Promise",
  async (runtime) => {
    let release!: (value: string) => void;
    const held = new NativePromise<string>((resolve) => {
      release = resolve;
    });
    const failure = new Error("failed peer");
    vi.stubGlobal("Promise", runtime === "bluebird" ? PromiseBB : NativePromise);
    let completed = false;
    try {
      const result = settleAll([NativePromise.reject(failure), held]).then((outcomes) => {
        completed = true;
        return outcomes;
      });
      await setImmediate();
      expect(completed).toBe(false);
      release("finished");
      expect(await result).toEqual([
        { status: "rejected", reason: failure },
        { status: "fulfilled", value: "finished" },
      ]);
    } finally {
      release("finished");
      vi.unstubAllGlobals();
    }
  },
);
