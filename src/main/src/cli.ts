import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { IParameters, ISetItem } from "@vortex/shared/cli";
import { Command, type Option } from "commander";
import { app, BrowserWindow } from "electron";

import { getVortexPath } from "./getVortexPath";
import { log } from "./logging";

function findOption(command: Command, argument: string): Option | undefined {
  const flag = argument.split("=", 1)[0];
  // Commander4 exposes this metadata through an untyped index signature.
  const options = command.options as readonly Option[];
  return (
    options.find((option) => option.short === flag || option.long === flag) ??
    options.find(
      (option) =>
        (option.required || option.optional) &&
        option.short !== undefined &&
        argument.startsWith(option.short),
    )
  );
}

function takesFollowingValue(option: Option | undefined, argument: string): boolean {
  return (
    option !== undefined &&
    (option.required || option.optional) &&
    (argument === option.short || argument === option.long)
  );
}

/** Electron groups switches before values in second-instance events. */
function restoreElectronArguments(argv: string[], command: Command, defaultApp: boolean): string[] {
  const firstValue = argv.findIndex((argument, index) => index > 0 && !argument.startsWith("-"));
  if (firstValue === -1) return [...argv];
  const values = argv.slice(firstValue);
  const restored = argv.slice(0, 1);
  if (defaultApp) {
    const application = values.shift();
    if (application !== undefined) restored.push(application);
  }
  for (const argument of argv.slice(1, firstValue)) {
    restored.push(argument);
    const option = findOption(command, argument);
    if (takesFollowingValue(option, argument)) {
      const value = values.shift();
      if (value !== undefined) restored.push(value);
    }
  }
  return [...restored, ...values];
}

/** Linux desktop entries can pass a raw URI; values of explicit options stay values. */
function normalizeLinuxProtocolArguments(
  argv: string[],
  command: Command,
  defaultApp: boolean,
): string[] {
  const normalized = [...argv];
  let rawUriIndex = -1;
  for (let index = defaultApp ? 2 : 1; index < normalized.length; index++) {
    const argument = normalized[index];
    if (argument === "--") break;
    const option = findOption(command, argument ?? "");
    if (option && ["--download", "--install"].includes(option.long ?? "")) return argv;
    if (rawUriIndex === -1 && argument?.startsWith("nxm://")) rawUriIndex = index;
    if (takesFollowingValue(option, argument ?? "")) index++;
  }
  if (rawUriIndex !== -1) normalized.splice(rawUriIndex, 0, "-d");
  return normalized;
}

/**
 * I think we are going to need this to transform what epic sends us which we can't help into
 * something that our commander.js library is going to parse successfully without going crazy
 * and replacing the parsing library.
 *
 * I think we are hitting walls atm with having only a single hyphen but with a word and a =
 */
function transformEpicArguments(argv: string[]): string[] {
  const epicParameterSwaps = {
    "-AUTH_LOGIN": "--epic-auth-login",
    "-AUTH_PASSWORD": "--epic-auth-password",
    "-AUTH_TYPE": "--epic-auth-type",
    "-epicapp": "--epic-app",
    "-epicenv": "--epic-env",
    "-EpicPortal": "--epic-portal",
    "-epicusername": "--epic-username",
    "-epicuserid": "--epic-userid",
    "-epiclocale": "--epic-locale",
    "-epicsandboxid": "--epic-sandboxid",
  } as const;

  const resultArr = argv.map((element) => {
    for (const [key, value] of Object.entries(epicParameterSwaps)) {
      if (element.indexOf(key) !== -1) {
        return element.replace(key, value);
      }
    }

    return element;
  });

  return resultArr;
}

// arguments that should be dropped when restarting the application
const SKIP_ARGS: Record<string, number> = {
  "-d": 1,
  "--download": 1,
  "-i": 1,
  "--start-minimized": 1,
  "--game": 1,
  "--profile": 1,
  "--install": 1,
  "--install-archive": 1,
  "--restore": 1,
  "--merge": 1,
};

export function filterArgs(input: string[]): string[] {
  let skipCount = 0;
  const result = Array<string>();

  input.forEach((arg, idx) => {
    if (skipCount > 0) {
      skipCount--;
    } else if (idx === 0) {
      // skip
    } else if (SKIP_ARGS[arg] !== undefined) {
      skipCount = SKIP_ARGS[arg];
    } else {
      result.push(arg);
    }
  });

  return result;
}

function assign(input: string, prev: ISetItem[]): ISetItem[] | undefined {
  const [key, value] = input.split("=");
  if (key && value) return (prev ?? []).concat([{ key, value }]);
  return undefined;
}

function collect(value: string, prev: string[]): string[] {
  return (prev ?? []).concat([value]);
}

function getStartupSettingsPath(): string {
  return path.join(getVortexPath("appData"), app.name, "startup.json");
}

export function getStartupSettings(): IParameters {
  const filePath = getStartupSettingsPath();

  try {
    const contents = readFileSync(filePath, "utf-8");
    return JSON.parse(contents) as IParameters;
  } catch (err) {
    log("warn", "failed to parse startup.json file", {
      path: filePath,
      error: err,
    });
    return {};
  }
}

export function updateStartupSettings(updater: (current: IParameters) => IParameters): void {
  const filePath = getStartupSettingsPath();
  const current = getStartupSettings();
  const updated = updater(current);
  const json = JSON.stringify(updated);
  writeFileSync(filePath, json);
}

interface ICommandlinePayload {
  vortexCommandline: { version: 1; argv: string[]; defaultApp: boolean };
}

/** Preserve the original order before Chromium reconstructs a second-instance argv. */
export function getCommandlinePayload(): ICommandlinePayload {
  return {
    vortexCommandline: {
      version: 1,
      argv: [...process.argv],
      defaultApp: process.defaultApp === true,
    },
  };
}

function isCommandlinePayload(data: unknown): data is ICommandlinePayload {
  if (typeof data !== "object" || data === null || !("vortexCommandline" in data)) return false;
  const payload = data.vortexCommandline;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "version" in payload &&
    payload.version === 1 &&
    "defaultApp" in payload &&
    typeof payload.defaultApp === "boolean" &&
    "argv" in payload &&
    Array.isArray(payload.argv) &&
    payload.argv.length >= (payload.defaultApp ? 2 : 1) &&
    payload.argv.every((argument: unknown) => typeof argument === "string")
  );
}

export function parseSecondaryCommandline(argv: string[], additionalData: unknown): IParameters {
  if (isCommandlinePayload(additionalData)) {
    const payload = additionalData.vortexCommandline;
    return parseCommandline(payload.argv, false, payload.defaultApp);
  }
  return parseCommandline(argv, true);
}

export function parseCommandline(
  argv: string[],
  electronReordered: boolean,
  defaultApp = process.defaultApp === true,
): IParameters {
  let version: string = "1.0.0";
  try {
    // won't happen in regular operation but lets us test this function outside vortex
    version = app.getVersion();
  } catch {
    // nop
  }

  const command = new Command("Vortex")
    .version(version)
    .option(
      "-d, --download <url>",
      "Start downloading the specified url " + "(any supported protocol like nxm:, https:, ...).",
    )
    .option(
      "-i, --install <url>",
      "Start downloading & installing the specified url " +
        "(any supported protocol like nxm:, https:, ...).",
    )
    .option(
      "--install-archive <path>",
      "Start installing the specified archive. Use absolute path.",
    )
    .option(
      "-g, --get <path>",
      "Print the state variable at the specified path and quit. " +
        "This can be used repeatedly to print multiple items",
      collect,
    )
    .option(
      "-s, --set <path=value>",
      "Change a value in the state. Please be very careful " +
        "with this, incorrect use will break Vortex and you may " +
        "lose data",
      assign,
    )
    .option("--del <path>", "Remove a value in state", collect)
    .option(
      "--user-data <path>",
      "Starts Vortex with a custom directory for the user data. " +
        "Only use if you know what you're doing.",
    )
    .option("--start-minimized", "Starts Vortex in the task bar")
    .option("--game <game id>", "Starts Vortex with a different game enabled")
    .option("--run <path>", "Execute the js program instead of Vortex itself.")
    .option("--report <path>", "Send an error report. For internal use")
    .option("--restore <path>", "Restore a state backup")
    .option(
      "--merge <path>",
      "Merge a state backup. Unlike restore, the content of the specified " +
        "state file will be merged into the existing state.",
    )
    .option(
      "--shared",
      "Used in conjunction with set, get or del, this will access the database" +
        "in the shared location instead of the per-user one",
    )
    .option(
      "--max-memory <size in MB>",
      "Maximum amount of memory Vortex may use in MB " + "(defaults to 4096)",
    )
    .option("--inspector", "Start Vortex with the chrome inspector opened")
    .option("--profile <profile id>", "Start Vortex with a specific profile active")
    .option("--epic-auth-login <login>")
    .option("--epic-auth-password <password>")
    .option("--epic-auth-type <type>")
    .option("--epic-app <app>")
    .option("--epic-env <env>")
    .option("--epic-portal")
    .option("--epic-username <username>")
    .option("--epic-userid <userid>")
    .option("--epic-locale <locale>")
    .option("--epic-sandboxid <sandboxid>")
    // allow unknown options since they may be interpreted by electron/node
    .allowUnknownOption(true);

  let normalized = transformEpicArguments(argv ?? []);
  if (electronReordered) normalized = restoreElectronArguments(normalized, command, defaultApp);
  if (process.platform === "linux")
    normalized = normalizeLinuxProtocolArguments(normalized, command, defaultApp);
  // Commander expects a node executable and script prefix; packaged Electron has only its executable.
  const commandLine = command
    .parse(defaultApp ? normalized : ["Vortex", ...normalized])
    .opts() as IParameters;

  return {
    ...getStartupSettings(),
    ...commandLine,
  };
}

export function relaunch(args?: string[]) {
  app.relaunch({ args: [...filterArgs(process.argv), ...(args || [])] });
  // Close windows rather than calling app.quit() directly: Application's
  // window-all-closed handler performs the async finalize / waitForRendererExit
  // / DuckDB shutdown sequence and calls app.quit() itself at the end.
  // Calling app.quit() here races that cleanup and hangs the relaunch.
  for (const win of BrowserWindow.getAllWindows()) {
    win.close();
  }
}
