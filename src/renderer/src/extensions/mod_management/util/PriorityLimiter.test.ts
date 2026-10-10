import { describe, expect, it } from "vitest";

import PriorityLimiter from "./PriorityLimiter";

interface IGate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): IGate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PriorityLimiter", () => {
  it("starts a task synchronously while a slot is free", () => {
    const limiter = new PriorityLimiter(2);
    let started = false;
    void limiter.do(() => {
      started = true;
      return Promise.resolve();
    });
    expect(started).toBe(true);
    expect(limiter.running).toBe(1);
  });

  it("never runs more than the limit at once", async () => {
    const limiter = new PriorityLimiter(2);
    let running = 0;
    let peak = 0;
    const gates = [gate(), gate(), gate(), gate(), gate()];
    const all = gates.map((g) =>
      limiter.do(async () => {
        ++running;
        peak = Math.max(peak, running);
        await g.promise;
        --running;
      }),
    );
    for (const g of gates) {
      await tick();
      g.open();
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(limiter.running).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it("starts waiting tasks highest priority first, FIFO among equals", async () => {
    const limiter = new PriorityLimiter(1);
    const order: string[] = [];
    const blocker = gate();
    const first = limiter.do(() => blocker.promise);
    const queued = [
      ["small-a", 10],
      ["large", 1000],
      ["small-b", 10],
      ["medium", 100],
      ["small-c", 10],
    ] as const;
    const all = queued.map(([name, priority]) =>
      limiter.doAt(priority, () => {
        order.push(name);
        return Promise.resolve();
      }),
    );
    expect(limiter.waiting).toBe(5);
    blocker.open();
    await first;
    await Promise.all(all);
    expect(order).toEqual(["large", "medium", "small-a", "small-b", "small-c"]);
  });

  it("with one priority behaves as a FIFO queue", async () => {
    const limiter = new PriorityLimiter(1);
    const order: number[] = [];
    const blocker = gate();
    const first = limiter.do(() => blocker.promise);
    const all = [1, 2, 3, 4].map((n) =>
      limiter.do(() => {
        order.push(n);
        return Promise.resolve();
      }),
    );
    blocker.open();
    await first;
    await Promise.all(all);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("frees the slot and forwards the error when a task fails or throws", async () => {
    const limiter = new PriorityLimiter(1);
    await expect(limiter.do(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await expect(
      limiter.do(() => {
        throw new Error("throw");
      }),
    ).rejects.toThrow("throw");
    expect(limiter.running).toBe(0);
    await expect(limiter.do(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it("clearQueue drops waiting tasks and frees the slots without overshooting later", async () => {
    const limiter = new PriorityLimiter(1);
    const old = gate();
    const running = limiter.do(() => old.promise);
    let dropped = false;
    void limiter.do(() => {
      dropped = true;
      return Promise.resolve();
    });
    limiter.clearQueue();
    expect(limiter.waiting).toBe(0);
    expect(limiter.running).toBe(0);
    const fresh = gate();
    const next = limiter.do(() => fresh.promise);
    expect(limiter.running).toBe(1);
    old.open();
    await running;
    // the old task finishing must not free the new task's slot
    expect(limiter.running).toBe(1);
    fresh.open();
    await next;
    expect(limiter.running).toBe(0);
    expect(dropped).toBe(false);
  });

  it("keeps a quarter of the slots for the smallest waiting tasks", async () => {
    const limiter = new PriorityLimiter(4);
    const started: number[] = [];
    const blockers = [gate(), gate(), gate(), gate()];
    const first = blockers.map((b) => limiter.do(() => b.promise));
    const running = new Map<number, IGate>();
    const all = [50, 10, 90, 30, 70].map((size) =>
      limiter.doAt(size, () => {
        started.push(size);
        const g = gate();
        running.set(size, g);
        return g.promise;
      }),
    );
    // the first freed slot goes to the smallest (one slot of four is for the smallest), the next
    // ones to the largest while the smallest still runs
    for (const b of blockers.slice(0, 3)) {
      b.open();
      await tick();
    }
    expect(started).toEqual([10, 90, 70]);
    // once the smallest finishes, its slot takes the next smallest
    running.get(10)!.open();
    await tick();
    expect(started).toEqual([10, 90, 70, 30]);
    blockers[3]!.open();
    await tick();
    expect(started).toEqual([10, 90, 70, 30, 50]);
    for (const g of running.values()) g.open();
    await Promise.all([...first, ...all]);
  });

  it("with smallestSlots 0 starts strictly highest priority first", async () => {
    const limiter = new PriorityLimiter(4, { smallestSlots: 0 });
    const order: number[] = [];
    const blockers = [gate(), gate(), gate(), gate()];
    const first = blockers.map((b) => limiter.do(() => b.promise));
    const all = [50, 10, 90].map((size) =>
      limiter.doAt(size, () => {
        order.push(size);
        return Promise.resolve();
      }),
    );
    for (const b of blockers) b.open();
    await Promise.all([...first, ...all]);
    expect(order).toEqual([90, 50, 10]);
  });
});
