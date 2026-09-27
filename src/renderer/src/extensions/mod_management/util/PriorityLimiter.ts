/**
 * Concurrency limiter whose waiting tasks start in priority order, highest first. Tasks of equal
 * priority start in the order they were queued, so with a single priority it behaves like the
 * FIFO ConcurrencyLimiter it replaces in the install pipeline.
 *
 * The install pipeline gives a collection member its archive size as priority: the largest
 * archives take the longest to extract, and starting them first keeps them from running alone at
 * the end of the install. Up to `smallestSlots` of the slots take the lowest-priority (smallest)
 * waiting task instead: small archives extract in moments but each still costs the renderer a
 * fixed amount of work, so they keep flowing alongside the large ones rather than all queueing up
 * for the end.
 */
interface IWaiting {
  priority: number;
  start: (fromBack: boolean) => void;
}

export interface IPriorityLimiterOptions {
  /**
   * slots that take the lowest-priority waiting task while any is waiting; default a quarter of
   * the slots, rounded down (1 of 5, 2 of 10)
   */
  smallestSlots?: number;
}

class PriorityLimiter {
  private mLimit: number;
  private mSmallestSlots: number;
  private mRunning: number = 0;
  private mRunningSmallest: number = 0;
  private mWaiting: IWaiting[] = [];
  private mGeneration: number = 0;

  constructor(limit: number, options: IPriorityLimiterOptions = {}) {
    this.mLimit = limit;
    this.mSmallestSlots = Math.min(options.smallestSlots ?? Math.floor(limit / 4), limit);
  }

  public get running(): number {
    return this.mRunning;
  }

  public get waiting(): number {
    return this.mWaiting.length;
  }

  /**
   * Drop every waiting task (its promise never settles) and free all slots for new tasks, as
   * ConcurrencyLimiter.clearQueue does. Tasks still running don't count against the new slots.
   */
  public clearQueue(): void {
    this.mWaiting = [];
    this.mRunning = 0;
    this.mRunningSmallest = 0;
    ++this.mGeneration;
  }

  /**
   * run cb once a slot is free. The callback starts synchronously when a slot is free and nothing
   * is waiting.
   */
  public do<T>(cb: () => PromiseLike<T> | T): Promise<T> {
    return this.doAt(0, cb);
  }

  /**
   * like do, at the given priority: when no slot is free it starts before every waiting task of
   * lower priority (except in the smallest-first slots).
   */
  public doAt<T>(priority: number, cb: () => PromiseLike<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (fromBack: boolean) => {
        const generation = this.mGeneration;
        ++this.mRunning;
        if (fromBack) {
          ++this.mRunningSmallest;
        }
        let res: PromiseLike<T> | T;
        try {
          res = cb();
        } catch (err) {
          res = Promise.reject(err);
        }
        // free the slot before the caller sees the result, as ConcurrencyLimiter does
        const release = () => {
          if (generation === this.mGeneration) {
            --this.mRunning;
            if (fromBack) {
              --this.mRunningSmallest;
            }
            this.next();
          }
        };
        Promise.resolve(res).then(
          (value) => {
            release();
            resolve(value);
          },
          (err: unknown) => {
            release();
            reject(err);
          },
        );
      };
      if (this.mRunning < this.mLimit && this.mWaiting.length === 0) {
        start(false);
        return;
      }
      // insert after every entry of the same or higher priority (stable among equals)
      let idx = this.mWaiting.findIndex((iter) => iter.priority < priority);
      if (idx === -1) {
        idx = this.mWaiting.length;
      }
      this.mWaiting.splice(idx, 0, { priority, start });
      this.next();
    });
  }

  private next() {
    while (this.mRunning < this.mLimit && this.mWaiting.length > 0) {
      if (this.mRunningSmallest < this.mSmallestSlots) {
        this.mWaiting.pop()!.start(true);
      } else {
        this.mWaiting.shift()!.start(false);
      }
    }
  }
}

export default PriorityLimiter;
