import * as path from "path";

/** cmd parses a command string, not the C runtime's escaped argument format. */
export function windowsVerbatimArguments(executable: string, shell: boolean): boolean {
  return process.platform === "win32" && (shell || isWindowsCommandInterpreter(executable));
}

export function isWindowsCommandInterpreter(executable: string): boolean {
  return process.platform === "win32" && /^cmd(?:\.exe)?$/i.test(path.basename(executable));
}

/** Later launch layers override Windows variables regardless of their spelling. */
export function mergeLaunchEnvironment<T>(...layers: Record<string, T>[]): Record<string, T> {
  const result: Record<string, T> = {};
  const spelling = new Map<string, string>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      const identity = process.platform === "win32" ? key.toLowerCase() : key;
      const previous = spelling.get(identity);
      if (previous !== undefined) delete result[previous];
      spelling.set(identity, key);
      result[key] = value;
    }
  }
  return result;
}
