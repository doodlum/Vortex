import { createHash, type Hash } from "node:crypto";

/** Reads `length` bytes of the file being written, from `position`. */
export type RangeReader = (position: number, length: number) => Promise<Buffer>;

/**
 * MD5 of a file computed while it is being written, so the finished download doesn't have to be
 * read again just to hash it.
 *
 * Writes are reported after they reach the file. A write that continues the hashed prefix is
 * hashed from its buffer. A write further ahead (another chunk of a chunked download) is only
 * recorded; once the prefix reaches it, it is read back from the file, while it is still in the
 * page cache. Writes ahead of the prefix are never buffered in memory.
 *
 * The result is only given when it is certainly the hash of the file: any write into bytes that
 * were already hashed (a retry rewriting them), overlapping writes ahead, or more than
 * `maxAheadBytes` waiting ahead of the prefix give up, and the caller hashes the finished file
 * as before.
 */
export class ContiguousHash {
  #hash: Hash = createHash("md5");
  /** end of the bytes queued for hashing, in file order */
  #scheduledTo = 0;
  /** end of the bytes actually hashed */
  #hashedTo = 0;
  /** written ranges ahead of the prefix, [start, end), sorted by start, not overlapping */
  #ahead: Array<[number, number]> = [];
  #aheadBytes = 0;
  #chain: Promise<void> = Promise.resolve();
  #failed: string | undefined;
  readonly #read: RangeReader;
  readonly #maxAheadBytes: number;

  constructor(read: RangeReader, maxAheadBytes: number = Number.MAX_SAFE_INTEGER) {
    this.#read = read;
    this.#maxAheadBytes = maxAheadBytes;
  }

  /** why hashing gave up, undefined while it is still valid */
  get failed(): string | undefined {
    return this.#failed;
  }

  /**
   * Report bytes already on disk (a resumed download's completed ranges); they are read back when
   * the prefix reaches them.
   */
  existing(start: number, end: number): void {
    this.#record(start, end);
    this.#advance();
  }

  /** report `data`, written to the file at `position` */
  written(position: number, data: Buffer): void {
    if (this.#failed !== undefined || data.length === 0) {
      return;
    }
    if (position < this.#scheduledTo) {
      this.#fail(`rewrite at ${position} of bytes already hashed up to ${this.#scheduledTo}`);
      return;
    }
    if (position === this.#scheduledTo) {
      this.#scheduledTo += data.length;
      this.#queue(() => this.#update(data));
    } else {
      this.#record(position, position + data.length);
    }
    this.#advance();
  }

  /**
   * MD5 (hex) of the first `size` bytes, or undefined when it isn't known for certain: hashing gave
   * up, or not all of those bytes were reported.
   */
  async digest(size: number): Promise<string | undefined> {
    await this.#chain;
    if (this.#failed !== undefined || this.#hashedTo !== size || this.#ahead.length > 0) {
      return undefined;
    }
    return this.#hash.digest("hex");
  }

  #record(start: number, end: number): void {
    if (this.#failed !== undefined || end <= start) {
      return;
    }
    if (start < this.#scheduledTo) {
      this.#fail(`range ${start}-${end} overlaps bytes already hashed`);
      return;
    }
    let idx = this.#ahead.findIndex(([s]) => s > start);
    if (idx === -1) {
      idx = this.#ahead.length;
    }
    const prev = this.#ahead[idx - 1];
    const next = this.#ahead[idx];
    if ((prev !== undefined && prev[1] > start) || (next !== undefined && next[0] < end)) {
      this.#fail(`range ${start}-${end} overlaps another write`);
      return;
    }
    this.#ahead.splice(idx, 0, [start, end]);
    this.#aheadBytes += end - start;
    if (this.#aheadBytes > this.#maxAheadBytes) {
      this.#fail(`more than ${this.#maxAheadBytes} bytes written ahead of the hashed prefix`);
    }
  }

  /** queue read-backs of recorded ranges that now continue the prefix */
  #advance(): void {
    for (
      let first = this.#ahead[0];
      this.#failed === undefined && first !== undefined && first[0] === this.#scheduledTo;
      first = this.#ahead[0]
    ) {
      this.#ahead.shift();
      const [start, end] = first;
      this.#aheadBytes -= end - start;
      this.#scheduledTo = end;
      this.#queue(async () => {
        const data = await this.#read(start, end - start);
        if (data.length !== end - start) {
          throw new Error(`short read at ${start}: ${data.length} of ${end - start} bytes`);
        }
        this.#update(data);
      });
    }
  }

  #update(data: Buffer): void {
    this.#hash.update(data);
    this.#hashedTo += data.length;
  }

  #queue(step: () => void | Promise<void>): void {
    this.#chain = this.#chain.then(async () => {
      if (this.#failed !== undefined) {
        return;
      }
      try {
        await step();
      } catch (err) {
        this.#fail(err instanceof Error ? err.message : String(err));
      }
    });
  }

  #fail(reason: string): void {
    if (this.#failed === undefined) {
      this.#failed = reason;
      this.#ahead = [];
      this.#aheadBytes = 0;
    }
  }
}
