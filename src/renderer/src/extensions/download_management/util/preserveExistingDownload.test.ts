import type * as FsPromises from "node:fs/promises";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import { preserveExistingDownload } from "./preserveExistingDownload";

const linkFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  linkFile.mockImplementation(actual.link);
  return { ...actual, default: { ...actual, link: linkFile }, link: linkFile };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  linkFile.mockReset().mockImplementation(actual.link);
});

describe("forced new download finalization", () => {
  test("keeps an existing archive and moves different bytes to a distinct name", async () => {
    const folder = await makeTempDir("preserve-download-");
    const old = path.join(folder, "member.zip");
    const temp = path.join(folder, "__vortex_tmp_1");
    await writeFile(old, "old collection bytes");
    await writeFile(temp, "new collection bytes");
    const result = await preserveExistingDownload(temp, old);
    expect(result).not.toBe(old);
    expect(await readFile(old, "utf8")).toBe("old collection bytes");
    expect(await readFile(result, "utf8")).toBe("new collection bytes");
    expect(await readdir(folder)).not.toContain(path.basename(temp));
  });

  test("concurrent completions with the same server name preserve both files", async () => {
    const folder = await makeTempDir("preserve-concurrent-");
    const target = path.join(folder, "member.zip");
    const temps = [path.join(folder, "temp-a"), path.join(folder, "temp-b")];
    await Promise.all(temps.map((temp, index) => writeFile(temp, `bytes-${index}`)));
    const names = await Promise.all(temps.map((temp) => preserveExistingDownload(temp, target)));
    expect(new Set(names).size).toBe(2);
    expect(await Promise.all(names.map((name) => readFile(name, "utf8")))).toEqual([
      "bytes-0",
      "bytes-1",
    ]);
  });

  test("a destination filesystem error preserves the downloaded temp bytes", async () => {
    const folder = await makeTempDir("preserve-error-");
    const temp = path.join(folder, "temp");
    const absentFolder = path.join(folder, "missing", "member.zip");
    await writeFile(temp, "downloaded bytes");
    await expect(preserveExistingDownload(temp, absentFolder)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(temp, "utf8")).toBe("downloaded bytes");
    await mkdir(path.dirname(absentFolder));
  });
});

test("exclusive copy fallback preserves the existing destination", async () => {
  const folder = await makeTempDir("preserve-copy-");
  const old = path.join(folder, "member.zip");
  const temp = path.join(folder, "temp");
  await writeFile(old, "old bytes");
  await writeFile(temp, "new bytes");
  linkFile.mockRejectedValue(Object.assign(new Error("links unsupported"), { code: "EXDEV" }));
  const result = await preserveExistingDownload(temp, old);
  expect(linkFile).toHaveBeenCalled();
  expect(result).not.toBe(old);
  expect(await readFile(old, "utf8")).toBe("old bytes");
  expect(await readFile(result, "utf8")).toBe("new bytes");
  expect(await readdir(folder)).not.toContain("temp");
});

test("exclusive copy failure leaves the original and downloaded temp bytes", async () => {
  const folder = await makeTempDir("preserve-copy-error-");
  const temp = path.join(folder, "temp");
  const destination = path.join(folder, "missing", "member.zip");
  await writeFile(temp, "new bytes");
  linkFile.mockRejectedValue(Object.assign(new Error("links unsupported"), { code: "EXDEV" }));
  await expect(preserveExistingDownload(temp, destination)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(temp, "utf8")).toBe("new bytes");
});

test("concurrent browser copies keep independently owned sources and destinations", async () => {
  const folder = await makeTempDir("preserve-browser-");
  const target = path.join(folder, "member.zip");
  const sources = [path.join(folder, "browser-a"), path.join(folder, "browser-b")];
  await Promise.all(sources.map((source, index) => writeFile(source, "bytes-" + index)));
  const destinations = await Promise.all(
    sources.map((source) => preserveExistingDownload(source, target, { keepSource: true })),
  );
  expect(new Set(destinations).size).toBe(2);
  expect(await Promise.all(destinations.map((name) => readFile(name, "utf8")))).toEqual([
    "bytes-0",
    "bytes-1",
  ]);
  expect(await Promise.all(sources.map((name) => readFile(name, "utf8")))).toEqual([
    "bytes-0",
    "bytes-1",
  ]);
  expect(linkFile).not.toHaveBeenCalled();
  await writeFile(sources[0], "later browser write");
  expect(await readFile(destinations[0], "utf8")).toBe("bytes-0");
});
