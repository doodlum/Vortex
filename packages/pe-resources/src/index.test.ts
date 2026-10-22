import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, it, expect } from "vitest";

import {
  findResourceSection,
  findResourceSectionSync,
  findResourceType,
  findFirstDataEntry,
  collectDataEntries,
} from "./index";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const PE_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../../extensions/games/game-baldursgate3/tools/divine.exe",
);

// --- Cross-platform tests (use committed PE fixture) ---

describe("findResourceSection (cross-platform)", () => {
  it("parses PE headers from the committed divine.exe fixture", async () => {
    const fh = await fsp.open(PE_FIXTURE, "r");
    try {
      const section = await findResourceSection(fh);
      expect(section).toBeDefined();
      expect(section!.buf.length).toBeGreaterThan(0);
      expect(section!.sectionVA).toBeGreaterThan(0);
      const offset = section!.resourceRVA - section!.sectionVA;
      const version = findResourceType(section!.buf, offset, RT_VERSION);
      expect(version).toBeDefined();
      const entry = findFirstDataEntry(section!.buf, version!);
      expect(entry).toBeDefined();
      expect(entry!.dataRVA).toBeGreaterThan(0);
      expect(entry!.dataSize).toBeGreaterThan(0);
    } finally {
      await fh.close();
    }
  });

  it("returns undefined for non-PE file", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pe-res-")), "test.txt");
    fs.writeFileSync(tmp, "not a PE file");
    const fh = await fsp.open(tmp, "r");
    try {
      expect(await findResourceSection(fh)).toBeUndefined();
    } finally {
      await fh.close();
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });

  it("returns undefined for truncated MZ header", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pe-res-")), "trunc.exe");
    // Valid MZ magic but file is too short for a real PE
    fs.writeFileSync(tmp, Buffer.from("MZ"));
    const fh = await fsp.open(tmp, "r");
    try {
      expect(await findResourceSection(fh)).toBeUndefined();
    } finally {
      await fh.close();
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });

  it("returns undefined for empty file", async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pe-res-")), "empty.exe");
    fs.writeFileSync(tmp, Buffer.alloc(0));
    const fh = await fsp.open(tmp, "r");
    try {
      expect(await findResourceSection(fh)).toBeUndefined();
    } finally {
      await fh.close();
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });
});

describe("findResourceSectionSync (cross-platform)", () => {
  it("parses PE headers from the committed divine.exe fixture", () => {
    const fd = fs.openSync(PE_FIXTURE, "r");
    try {
      const section = findResourceSectionSync(fd);
      expect(section).toBeDefined();
      expect(section!.buf.length).toBeGreaterThan(0);
      expect(section!.sectionVA).toBeGreaterThan(0);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("findResourceType (cross-platform)", () => {
  it("returns undefined when resource type is not present", async () => {
    const fh = await fsp.open(PE_FIXTURE, "r");
    try {
      const section = await findResourceSection(fh);
      expect(section).toBeDefined();
      const resourceOffset = section!.resourceRVA - section!.sectionVA;
      // This committed console fixture has a version resource and no cursor resource.
      expect(findResourceType(section!.buf, resourceOffset, 1)).toBeUndefined();
    } finally {
      await fh.close();
    }
  });
});

// --- Windows-only tests (use system executables) ---

describeOnWindows("findResourceSection (Windows)", () => {
  it("finds the resource section in notepad.exe", async () => {
    const fh = await fsp.open("C:\\Windows\\System32\\notepad.exe", "r");
    try {
      const section = await findResourceSection(fh);
      expect(section).toBeDefined();
      expect(section!.buf.length).toBeGreaterThan(0);
      expect(section!.sectionVA).toBeGreaterThan(0);
      expect(section!.resourceRVA).toBeGreaterThan(0);
    } finally {
      await fh.close();
    }
  });
});

describeOnWindows("findResourceType (Windows)", () => {
  it("finds RT_VERSION in notepad.exe", async () => {
    const fh = await fsp.open("C:\\Windows\\System32\\notepad.exe", "r");
    try {
      const section = (await findResourceSection(fh))!;
      const resourceOffset = section.resourceRVA - section.sectionVA;
      const typeOffset = findResourceType(section.buf, resourceOffset, RT_VERSION);
      expect(typeOffset).toBeDefined();
    } finally {
      await fh.close();
    }
  });

  it("finds RT_GROUP_ICON in notepad.exe", async () => {
    const fh = await fsp.open("C:\\Windows\\System32\\notepad.exe", "r");
    try {
      const section = (await findResourceSection(fh))!;
      const resourceOffset = section.resourceRVA - section.sectionVA;
      const typeOffset = findResourceType(section.buf, resourceOffset, RT_GROUP_ICON);
      expect(typeOffset).toBeDefined();
    } finally {
      await fh.close();
    }
  });

  it("finds RT_ICON in notepad.exe", async () => {
    const fh = await fsp.open("C:\\Windows\\System32\\notepad.exe", "r");
    try {
      const section = (await findResourceSection(fh))!;
      const resourceOffset = section.resourceRVA - section.sectionVA;
      const typeOffset = findResourceType(section.buf, resourceOffset, RT_ICON);
      expect(typeOffset).toBeDefined();
    } finally {
      await fh.close();
    }
  });
});

describeOnWindows("collectDataEntries (Windows)", () => {
  it("collects RT_ICON entries from notepad.exe", async () => {
    const fh = await fsp.open("C:\\Windows\\System32\\notepad.exe", "r");
    try {
      const section = (await findResourceSection(fh))!;
      const resourceOffset = section.resourceRVA - section.sectionVA;
      const iconDirOffset = findResourceType(section.buf, resourceOffset, RT_ICON)!;
      const entries = collectDataEntries(section.buf, iconDirOffset);
      expect(entries.size).toBeGreaterThan(0);

      for (const [id, entry] of entries) {
        expect(id).toBeGreaterThan(0);
        expect(entry.dataRVA).toBeGreaterThan(0);
        expect(entry.dataSize).toBeGreaterThan(0);
      }
    } finally {
      await fh.close();
    }
  });
});
