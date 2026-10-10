import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ContiguousHash } from "./contiguousHash";

const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");

/** a file in memory: writes land in it, reads come from it */
function file(size: number) {
  const disk = Buffer.alloc(size);
  let reads = 0;
  const hash = (maxAhead?: number) =>
    new ContiguousHash(async (position, length) => {
      ++reads;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Buffer.from(disk.subarray(position, position + length));
    }, maxAhead);
  const write = (h: ContiguousHash, position: number, data: Buffer) => {
    data.copy(disk, position);
    h.written(position, data);
  };
  return { disk, hash, write, reads: () => reads };
}

const pieces = (data: Buffer, size: number) => {
  const out: Array<[number, Buffer]> = [];
  for (let pos = 0; pos < data.length; pos += size) {
    out.push([pos, data.subarray(pos, pos + size)]);
  }
  return out;
};

describe("ContiguousHash", () => {
  it("hashes an in-order download from its buffers without reading the file", async () => {
    const data = randomBytes(100_000);
    const f = file(data.length);
    const h = f.hash();
    for (const [pos, piece] of pieces(data, 4096)) f.write(h, pos, piece);
    expect(await h.digest(data.length)).toBe(md5(data));
    expect(f.reads()).toBe(0);
  });

  it("hashes chunks written in parallel, reading back the ones ahead of the prefix", async () => {
    const data = randomBytes(200_000);
    const f = file(data.length);
    const h = f.hash();
    const chunkSize = 50_000;
    const chunks = [0, 1, 2, 3].map((i) =>
      pieces(data.subarray(i * chunkSize, (i + 1) * chunkSize), 3000).map(
        ([pos, piece]) => [pos + i * chunkSize, piece] as [number, Buffer],
      ),
    );
    // interleave the four chunks' writes, later chunks faster: chunk k writes k + 1 pieces per
    // round, so chunks 1-3 run ahead of the prefix and are read back
    const queues = chunks.map((c) => [...c]);
    while (queues.some((q) => q.length > 0)) {
      queues.forEach((queue, k) => {
        for (const [pos, piece] of queue.splice(0, k + 1)) f.write(h, pos, piece);
      });
    }
    expect(await h.digest(data.length)).toBe(md5(data));
    expect(f.reads()).toBeGreaterThan(0);
  });

  it("negative control: a rewrite of hashed bytes (a retry) gives no hash", async () => {
    const data = randomBytes(10_000);
    const f = file(data.length);
    const h = f.hash();
    f.write(h, 0, data.subarray(0, 6000));
    // the retry starts over and writes different bytes this time
    const retry = Buffer.from(data);
    retry.writeUInt8(retry.readUInt8(10) ^ 0xff, 10);
    f.write(h, 0, retry.subarray(0, 5000));
    f.write(h, 5000, retry.subarray(5000));
    expect(h.failed).toBeDefined();
    expect(await h.digest(data.length)).toBeUndefined();
  });

  it("gives no hash while bytes are missing or when too much is written ahead", async () => {
    const data = randomBytes(10_000);
    const gap = file(data.length);
    const h1 = gap.hash();
    gap.write(h1, 0, data.subarray(0, 4000));
    gap.write(h1, 6000, data.subarray(6000));
    expect(await h1.digest(data.length)).toBeUndefined();

    const ahead = file(data.length);
    const h2 = ahead.hash(1000);
    ahead.write(h2, 5000, data.subarray(5000, 7000));
    expect(h2.failed).toMatch(/ahead/);
    ahead.write(h2, 0, data.subarray(0, 5000));
    ahead.write(h2, 7000, data.subarray(7000));
    expect(await h2.digest(data.length)).toBeUndefined();
  });

  it("gives no hash when the file is larger than what was reported", async () => {
    const data = randomBytes(1000);
    const f = file(data.length);
    const h = f.hash();
    f.write(h, 0, data);
    expect(await h.digest(data.length + 1)).toBeUndefined();
  });

  it("gives no hash when overlapping writes land ahead of the prefix", () => {
    const data = randomBytes(10_000);
    const f = file(data.length);
    const h = f.hash();
    f.write(h, 5000, data.subarray(5000, 8000));
    f.write(h, 7000, data.subarray(7000, 9000));
    expect(h.failed).toMatch(/overlaps/);
  });
});
