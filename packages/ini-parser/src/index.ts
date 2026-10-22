import winapi from "winapi-bindings";

import { PortableIniFormat, type IniChanges, type IniData, type IniFormat } from "./portable";

// The native binding converts values itself and accepts null for deletion;
// its TypeScript declaration only describes the string-valued overload.
function writeProfile(section: string, key: string, value: unknown, file: string): void {
  Reflect.apply(winapi.WritePrivateProfileString, undefined, [section, key, value, file]);
}

export { PortableIniFormat } from "./portable";
export type { IniChanges, IniData, IniFormat, PortableIniOptions } from "./portable";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function flattened(
  data: unknown,
  prefix = "",
  result = new Map<string, unknown>(),
): Map<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    result.set(prefix, data);
  } else {
    for (const [name, value] of Object.entries(data))
      flattened(value, prefix === "" ? name : prefix + "###" + name, result);
  }
  return result;
}

/** Mutable INI data with a committed snapshot for subsequent delta writes. */
export class IniFile<T = any> {
  private stored: T;
  private mutable: T | undefined;
  public constructor(data: T) {
    this.stored = clone(data);
  }
  public get data(): T {
    return (this.mutable ??= clone(this.stored));
  }
  public set data(value: T) {
    this.mutable = value;
  }
  public changes(): IniChanges {
    const before = flattened(this.stored);
    const after = flattened(this.mutable ?? this.stored);
    return {
      removed: [...before.keys()].filter((key) => !after.has(key)),
      added: [...after.keys()].filter((key) => !before.has(key)),
      changed: [...after.keys()].filter(
        (key) =>
          before.has(key) && JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)),
      ),
    };
  }
  public apply(): void {
    if (this.mutable !== undefined) this.stored = clone(this.mutable);
  }
}

/** The existing Win32 backend on Windows, and its portable file backend on Linux. */
export class WinapiFormat implements IniFormat {
  private readonly portable = new PortableIniFormat();
  public async read(filePath: string): Promise<IniData> {
    if (process.platform !== "win32") return this.portable.read(filePath);
    const result: IniData = Object.create(null);
    for (const section of winapi.GetPrivateProfileSectionNames(filePath)) {
      result[section] = winapi.GetPrivateProfileSection(section, filePath);
    }
    return result;
  }
  public async write(filePath: string, data: IniData, changes: IniChanges): Promise<void> {
    if (process.platform !== "win32") return this.portable.write(filePath, data, changes);
    for (const fullKey of changes.removed) {
      const [section, key] = fullKey.split("###");
      writeProfile(section!, key!, null, filePath);
    }
    for (const fullKey of [...changes.added, ...changes.changed]) {
      const [section, key] = fullKey.split("###");
      writeProfile(section!, key!, data[section!]?.[key!], filePath);
    }
  }
}

/** Read a mutable file and commit only its recorded changes to the current disk file. */
export default class IniParser {
  private readonly format: IniFormat;
  public constructor(format: IniFormat = new WinapiFormat()) {
    this.format = format;
  }
  public async read<T = any>(filePath: string): Promise<IniFile<T>> {
    // The caller supplies the document shape, as in the previous parser API.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return new IniFile((await this.format.read(filePath)) as T);
  }
  public async write<T>(filePath: string, file: IniFile<T>): Promise<void> {
    // The backend validates edited keys and values; T describes the caller view.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await this.format.write(filePath, file.data as IniData, file.changes());
    file.apply();
  }
}
