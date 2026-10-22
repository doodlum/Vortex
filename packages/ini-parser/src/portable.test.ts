import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import iconv from "iconv-lite";
import { afterEach, beforeEach, expect, test } from "vitest";

import IniParser, { IniFile, PortableIniFormat, WinapiFormat } from "./index";
import expected from "./windows-native.json";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-ini-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const fixtures = {
  basic: Buffer.from(
    "; heading\r\nglobal=ignored\r\n[General]\r\n Key = value  \r\nQuoted=\" x \"\r\nSingle=' y '\r\nEmpty=\r\nBare\r\n#Hash=hash\r\n;Comment=ignore\r\n[Other]\r\nKeep=untouched\r\n",
    "utf8",
  ),
  duplicates: Buffer.from(
    "[General]\nKey=first\nKey=last\nkey=lower\n[General]\nLate=ignored?\n[general]\nLower=another\n",
    "utf8",
  ),
  syntax: Buffer.from(
    '  [General] trailing\n spaced key  =  value ; inline  \nquoted="some=value"\n;comment\n[Empty]\n[Brackets] ; foo\nx=1\n',
    "utf8",
  ),
  utf16le: Buffer.concat([
    Buffer.from([255, 254]),
    Buffer.from("; heading\r\n[General]\r\nUnicode=café\r\nKeep=中文\r\n", "utf16le"),
  ]),
  ansi: Buffer.from("[General]\r\nUnicode=caf\xe9\r\n", "latin1"),
};

for (const name of ["basic", "duplicates", "syntax", "utf16le", "ansi"] as const) {
  const input = fixtures[name];
  for (const format of [PortableIniFormat, WinapiFormat]) {
    test(format.name + ": matches native Windows delta output for " + name, async () => {
      const file = path.join(directory, name + ".ini");
      await fs.writeFile(file, input);
      const parser = new IniParser(new format());
      const ini = await parser.read(file);
      const reference = expected[name];
      expect(ini.data).toEqual(reference.before);
      ini.data.General.Key = "updated";
      ini.data.General.Added = "new";
      delete ini.data.General.Empty;
      await parser.write(file, ini);
      expect((await fs.readFile(file)).toString("hex")).toBe(reference.hex);
      expect((await parser.read(file)).data).toEqual(reference.after);
    });
  }
}

test("no-op writes preserve exact bytes, inode and modification time", async () => {
  const file = path.join(directory, "unchanged.ini");
  const bytes = Buffer.from("\ufeff; comment\n[General]\nName=café\n", "utf8");
  await fs.writeFile(file, bytes);
  const parser = new IniParser(new PortableIniFormat());
  const before = await fs.stat(file, { bigint: true });
  const ini = await parser.read(file);
  expect(ini.data.General.Name).toBe("café");
  await parser.write(file, ini);
  const after = await fs.stat(file, { bigint: true });
  expect(await fs.readFile(file)).toEqual(bytes);
  expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
});

test("keeps UTF-8 BOM and UTF-16BE bytes while editing Unicode values", async () => {
  for (const [encoding, bom] of [
    ["utf8", Buffer.from([239, 187, 191])],
    ["utf16be", Buffer.from([254, 255])],
  ] as const) {
    const file = path.join(directory, encoding + ".ini");
    await fs.writeFile(
      file,
      Buffer.concat([bom, iconv.encode(";中文\n[General]\nName=café\n", encoding)]),
    );
    const parser = new IniParser(new PortableIniFormat());
    const ini = await parser.read(file);
    ini.data.General.Name = "中文";
    await parser.write(file, ini);
    expect(await fs.readFile(file)).toEqual(
      Buffer.concat([bom, iconv.encode(";中文\n[General]\nName=中文\n", encoding)]),
    );
  }
});

test("supports an explicit legacy code page without changing unrelated text", async () => {
  const file = path.join(directory, "shift-jis.ini");
  const parser = new IniParser(new PortableIniFormat({ encoding: "shift_jis" }));
  await fs.writeFile(file, iconv.encode("; 日本語\r\n[General]\r\nName=日本語\r\n", "shift_jis"));
  const ini = await parser.read(file);
  expect(ini.data.General.Name).toBe("日本語");
  ini.data.General.Name = "変更";
  await parser.write(file, ini);
  expect(iconv.decode(await fs.readFile(file), "shift_jis")).toBe(
    "; 日本語\r\n[General]\r\nName=変更\r\n",
  );
});

test("unrepresentable edits fail before writing and a later valid write still works", async () => {
  const file = path.join(directory, "ansi.ini");
  await fs.writeFile(file, fixtures.ansi);
  const parser = new IniParser(new PortableIniFormat());
  const ini = await parser.read(file);
  ini.data.General.Unicode = "中文";
  await expect(parser.write(file, ini)).rejects.toThrow("cannot be represented");
  expect(await fs.readFile(file)).toEqual(fixtures.ansi);
  expect(ini.changes().changed).toEqual(["General###Unicode"]);
  ini.data.General.Unicode = "café edited";
  await parser.write(file, ini);
  expect(ini.changes()).toEqual({ added: [], changed: [], removed: [] });
});

test("committed snapshots detect a second in-place mutation", async () => {
  const file = path.join(directory, "second.ini");
  await fs.writeFile(file, "[General]\r\nName=first\r\n");
  const parser = new IniParser(new PortableIniFormat());
  const ini = await parser.read(file);
  ini.data.General.Name = "second";
  await parser.write(file, ini);
  ini.data.General.Name = "third";
  await parser.write(file, ini);
  expect((await parser.read(file)).data.General.Name).toBe("third");
});

test("concurrent deltas to one path retain both edits", async () => {
  const file = path.join(directory, "concurrent.ini");
  await fs.writeFile(file, "[General]\r\nA=old\r\nB=old\r\n");
  const parser = new IniParser(new PortableIniFormat());
  const first = await parser.read(file);
  const second = await parser.read(file);
  first.data.General.A = "first";
  second.data.General.B = "second";
  await Promise.all([parser.write(file, first), parser.write(file, second)]);
  expect((await parser.read(file)).data.General).toEqual({ A: "first", B: "second" });
});

test("writes through a hardlink and keeps its inode", async () => {
  const source = path.join(directory, "source.ini");
  const target = path.join(directory, "target.ini");
  await fs.writeFile(source, "[General]\r\nA=old\r\n");
  await fs.link(source, target);
  const parser = new IniParser(new PortableIniFormat());
  const ini = await parser.read(target);
  ini.data.General.A = "updated";
  await parser.write(target, ini);
  expect(await fs.readFile(source, "utf8")).toContain("A=updated");
  expect((await fs.stat(source, { bigint: true })).ino).toBe(
    (await fs.stat(target, { bigint: true })).ino,
  );
});

test("missing files read empty and receive only explicit changes", async () => {
  const file = path.join(directory, "missing.ini");
  const parser = new IniParser(new PortableIniFormat());
  const ini = await parser.read(file);
  expect(ini.data).toEqual({});
  ini.data.General = { Enabled: 1 };
  await parser.write(file, ini);
  expect(await fs.readFile(file, "utf8")).toBe("[General]\r\nEnabled=1\r\n");
});

test("invalid deltas do not truncate or inject lines into a file", async () => {
  const file = path.join(directory, "invalid.ini");
  await fs.writeFile(file, fixtures.basic);
  const parser = new IniParser(new PortableIniFormat());
  const ini = await parser.read(file);
  ini.data.General.Key = "value\n[Injected]";
  await expect(parser.write(file, ini)).rejects.toThrow("one line");
  expect(await fs.readFile(file)).toEqual(fixtures.basic);
});

test("refuses incomplete UTF-16 rather than rewriting damaged bytes", async () => {
  const file = path.join(directory, "damaged.ini");
  const bytes = Buffer.from([255, 254, 65]);
  await fs.writeFile(file, bytes);
  await expect(new PortableIniFormat().read(file)).rejects.toThrow("Incomplete UTF-16");
  expect(await fs.readFile(file)).toEqual(bytes);
});

test("section and key names cannot mutate object prototypes", async () => {
  const file = path.join(directory, "prototype.ini");
  await fs.writeFile(file, "[__proto__]\r\npolluted=yes\r\n[General]\r\n__proto__=value\r\n");
  const ini = await new IniParser(new PortableIniFormat()).read(file);
  expect(Object.hasOwn(ini.data, "__proto__")).toBe(true);
  expect(Object.hasOwn(ini.data.General, "__proto__")).toBe(true);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("fresh IniFile captures a snapshot independently of the caller object", () => {
  const data = { General: { Name: "old" } };
  const ini = new IniFile(data);
  data.General.Name = "external";
  expect(ini.data.General?.Name).toBe("old");
});
