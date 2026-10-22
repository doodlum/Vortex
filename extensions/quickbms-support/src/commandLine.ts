import type { IQBMSOptions } from "./types";

export function executableName(platform = process.platform, arch = process.arch): string {
  if (platform === "win32") return "quickbms_4gb_files.exe";
  if (platform === "linux" && (arch === "x64" || arch === "ia32")) return "quickbms_4gb_files";
  throw new Error(`QuickBMS has no bundled runtime for ${platform}/${arch}`);
}

/** Each option and path is one literal argument; no command shell interprets them. */
export function commandArguments(
  command: string | undefined,
  parameters: string[],
  options: IQBMSOptions,
  filterFile: string,
): string[] {
  const args: string[] = [];
  if (command) args.push(`-${command}`);
  if (options.allowResize !== undefined) {
    args.push("-r");
    if (options.allowResize) args.push("-r");
  }
  if (options.quiet) args.push("-q");
  if (options.overwrite) args.push("-o");
  if (options.caseSensitive) args.push("-I");
  if (options.keepTemporaryFiles) args.push("-T");
  if (options.wildCards) args.push("-f", filterFile);
  return args.concat(parameters);
}
