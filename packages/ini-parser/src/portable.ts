import { isUtf8 } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import iconv from "iconv-lite";

export type IniData = Record<string, Record<string, unknown>>;
export interface IniChanges {
  added: string[];
  changed: string[];
  removed: string[];
}
export interface IniFormat {
  read(filePath: string): Promise<IniData>;
  write(filePath: string, data: IniData, changes: IniChanges): Promise<void>;
}
export interface PortableIniOptions {
  encoding?: string;
}
interface Line {
  text: string;
  eol: string;
}
interface Document {
  lines: Line[];
  encoding: string;
  bom: Buffer;
}
interface Section {
  name: string;
  start: number;
  end: number;
}
interface Key {
  name: string;
  equal: number;
  value: string;
}

const writes = new Map<string, Promise<void>>();
const fold = (value: string): string => value.toUpperCase();

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new Error("INI values must be scalar strings, numbers or booleans");
}

function decode(bytes: Buffer, options: PortableIniOptions): Document {
  let encoding = options.encoding;
  let length = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf16le";
    length = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf16be";
    length = 2;
  } else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = "utf8";
    length = 3;
  }
  encoding ??= isUtf8(bytes) ? "utf8" : "windows-1252";
  if (!iconv.encodingExists(encoding)) throw new Error("Unsupported INI encoding: " + encoding);
  if (/^utf16/i.test(encoding) && (bytes.length - length) % 2 !== 0)
    throw new Error("Incomplete UTF-16 INI file");
  const text = iconv.decode(bytes.subarray(length), encoding, { stripBOM: false });
  const lines = [...text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => ({ text: match[1]!, eol: match[2]! }));
  return { lines, encoding, bom: bytes.subarray(0, length) };
}

function sections(lines: Line[]): Section[] {
  const result: Section[] = [];
  lines.forEach((line, index) => {
    const header = /^\s*\[([^\]]*)\]/.exec(line.text);
    if (header === null) return;
    const previous = result[result.length - 1];
    if (previous !== undefined) previous.end = index;
    result.push({ name: header[1]!, start: index, end: lines.length });
  });
  return result;
}

function key(line: Line): Key | undefined {
  if (/^\s*[;[]/.test(line.text)) return undefined;
  const equal = line.text.indexOf("=");
  if (equal === -1) return undefined;
  return {
    name: line.text.slice(0, equal).trim(),
    equal,
    value: line.text.slice(equal + 1).trim(),
  };
}

function dataOf(document: Document): IniData {
  const data: IniData = Object.create(null);
  const blocks = sections(document.lines);
  const firstBlocks = new Map<string, Section>();
  for (const block of blocks)
    if (!firstBlocks.has(fold(block.name))) firstBlocks.set(fold(block.name), block);
  for (const block of blocks) {
    if (Object.hasOwn(data, block.name)) continue;
    const first = firstBlocks.get(fold(block.name))!;
    const values: Record<string, unknown> = Object.create(null);
    for (let index = first.start + 1; index < first.end; ++index) {
      const entry = key(document.lines[index]!);
      if (entry !== undefined) values[entry.name] = entry.value;
    }
    data[block.name] = values;
  }
  return data;
}

function changeKey(fullKey: string): [string, string] {
  const parts = fullKey.split("###");
  if (parts.length !== 2 || /[\r\n\]]/.test(parts[0]!) || /[\r\n=]/.test(parts[1]!)) {
    throw new Error("Invalid INI section or key: " + fullKey);
  }
  return [parts[0]!, parts[1]!];
}

interface EditableSection {
  keys: Map<string, Line[]>;
  added: Line[];
}

/** Index once; applying many load-order edits must not reparse the whole file per key. */
class Editor {
  private readonly blocks = new Map<string, EditableSection>();
  private readonly inserts = new Map<Line, Line[]>();
  private readonly removed = new Set<Line>();
  private readonly appended: Line[] = [];
  public constructor(private readonly document: Document) {
    for (const section of sections(document.lines)) {
      if (this.blocks.has(fold(section.name))) continue;
      const block: EditableSection = { keys: new Map(), added: [] };
      let anchor = document.lines[section.start]!;
      for (let index = section.start + 1; index < section.end; ++index) {
        const line = document.lines[index]!;
        const entry = key(line);
        if (entry === undefined) continue;
        const name = fold(entry.name);
        const entries = block.keys.get(name) ?? [];
        entries.push(line);
        block.keys.set(name, entries);
        anchor = line;
      }
      this.blocks.set(fold(section.name), block);
      this.inserts.set(anchor, block.added);
    }
  }

  public edit(section: string, name: string, value: unknown): void {
    const remove = value === undefined || value === null;
    let block = this.blocks.get(fold(section));
    if (block === undefined) {
      if (remove) return;
      block = { keys: new Map(), added: [] };
      const header: Line = { text: "[" + section + "]", eol: "\r\n" };
      this.appended.push(header);
      this.inserts.set(header, block.added);
      this.blocks.set(fold(section), block);
    }
    const entries = block.keys.get(fold(name)) ?? [];
    const line = entries.find((candidate) => !this.removed.has(candidate));
    if (line !== undefined) {
      if (remove) this.removed.add(line);
      else {
        const equal = line.text.indexOf("=");
        const suffix = /[ \t]*$/.exec(line.text.slice(equal + 1))![0];
        line.text = line.text.slice(0, equal + 1) + scalar(value) + suffix;
      }
    } else if (!remove) {
      const added: Line = { text: name + "=" + scalar(value), eol: "\r\n" };
      block.added.push(added);
      entries.push(added);
      block.keys.set(fold(name), entries);
    }
  }

  public text(): string {
    const output: Line[] = [];
    for (const line of [...this.document.lines, ...this.appended]) {
      if (!this.removed.has(line)) output.push(line);
      output.push(...(this.inserts.get(line) ?? []).filter((added) => !this.removed.has(added)));
    }
    return output
      .map(
        (line, index) =>
          line.text + (index < output.length - 1 && line.eol === "" ? "\r\n" : line.eol),
      )
      .join("");
  }
}

async function readBytes(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return Buffer.alloc(0);
    throw error;
  }
}

/** Win32-style sections and delta updates without requiring a Windows native module. */
export class PortableIniFormat implements IniFormat {
  private readonly options: PortableIniOptions;
  public constructor(options: PortableIniOptions = {}) {
    this.options = options;
  }

  public async read(filePath: string): Promise<IniData> {
    return dataOf(decode(await readBytes(filePath), this.options));
  }

  public async write(filePath: string, data: IniData, changes: IniChanges): Promise<void> {
    if (changes.added.length + changes.changed.length + changes.removed.length === 0) return;
    // Serialize read-modify-write transactions, not only their final writes. Each
    // transaction applies its delta to the latest disk bytes and retains other edits.
    const identity = path.resolve(filePath);
    const previous = writes.get(identity) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const document = decode(await readBytes(filePath), this.options);
        const editor = new Editor(document);
        for (const fullKey of changes.removed) {
          const [section, name] = changeKey(fullKey);
          editor.edit(section, name, undefined);
        }
        for (const fullKey of [...changes.added, ...changes.changed]) {
          const [section, name] = changeKey(fullKey);
          const value = data[section]?.[name];
          if (/[\r\n]/.test(scalar(value)) || scalar(value).includes("\0"))
            throw new Error("INI values must occupy one line");
          editor.edit(section, name, value);
        }
        const text = editor.text();
        const bytes = iconv.encode(text, document.encoding);
        if (iconv.decode(bytes, document.encoding, { stripBOM: false }) !== text) {
          throw new Error("INI edit cannot be represented in " + document.encoding);
        }
        // Write through the existing path: INI files can be hardlinks or symlinks.
        // Replacing the inode would silently detach them from the staged source.
        await fs.writeFile(filePath, Buffer.concat([document.bom, bytes]));
        return undefined;
      });
    writes.set(identity, operation);
    try {
      await operation;
    } finally {
      if (writes.get(identity) === operation) writes.delete(identity);
    }
  }
}
