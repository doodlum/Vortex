import { spawn } from "child_process";
import * as path from "path";

import { fs, log, util } from "@nexusmods/vortex-api";
import Promise from "bluebird";

import { commandArguments, executableName } from "./commandLine";
import { IListEntry, IQBMSOpProps, IQBMSOptions, QuickBMSError } from "./types";

const FILTER_FILE_PATH = path.join(util.getVortexPath("userData"), "temp", "qbms", "filters.txt");
const LOG_FILE_PATH = path.join(util.getVortexPath("userData"), "quickbms.log");
const TIMEOUT_MSEC = 15000;
const CHECK_TIME_MSEC = 5000;

const QUICK_BMS_ERRORMSG = [
  "success", // 0
  "encountered an unknown error", // 1
  "unable to allocate memory, memory errors", // 2
  "missing input file", // 3
  "unable to write output file", // 4
  "file compression error (Review BMS script)", // 5
  "file encryption error (Review BMS script)", // 6
  "external dll file has reported an error", // 7
  "BMS script syntax error", // 8
  "invalid quickbms arguments provided", // 9
  "error accessing input/output folder", // 10
  "user/external application has terminated quickBMS", // 11
  "extra IO error", // 12
  "failed to update quickbms", // 13
  "QBMS has timed out", // 14 - this is reported by the timeout functionality.
];

function parseList(input: string, wildCards: string[] = ["{}"]): IListEntry[] {
  const lines = input.split("\n");
  const wildCardRgx = /{}|\*/g;
  const regexps: RegExp[] = wildCards.reduce((accum, wildCard) => {
    if (wildCardRgx.test(wildCard)) {
      const replacement = wildCard.replace(wildCardRgx, ".*");
      accum.push(new RegExp(replacement, "g"));
    }
    return accum;
  }, []);
  const findMatch = (filePath: string) => {
    if (wildCards.includes(filePath)) {
      return true;
    }

    let matched = false;
    for (const rgx of regexps) {
      if (rgx.test(filePath)) {
        matched = true;
        break;
      }
    }

    return matched;
  };
  const filtered: string[] = lines.filter((line) => !!line && !line.includes("- filter"));
  const res: IListEntry[] = filtered.reduce((accum, line) => {
    const match = /^\s*([0-9a-f]+)\s+(\d+)\s+(.+?)\s*$/i.exec(line);
    if (match !== null) {
      const [, offset, size, filePath] = match;
      if (findMatch(filePath)) {
        accum.push({ offset, size, filePath });
      }
    }
    return accum;
  }, []);

  return res;
}

function validateArguments(
  archivePath: string,
  bmsScriptPath: string,
  outPath: string,
  options: IQBMSOptions,
): Promise<void> {
  if (path.extname(bmsScriptPath) !== ".bms") {
    // Invalid argument - we were expecting a bms script.
    return Promise.reject(new util.ArgumentInvalid("bmsScriptPath"));
  }
  if (!path.isAbsolute(archivePath)) {
    // The archive's absolute path should've been provided.
    return Promise.reject(new util.ArgumentInvalid("archivePath"));
  }
  if (!path.isAbsolute(outPath)) {
    // outPath must be a directory and point towards an absolute path.
    return Promise.reject(new util.ArgumentInvalid("outPath"));
  }

  return Promise.resolve();
}

/**
 * The real file behind a path. An archive a virtual deployment serves exists only in Vortex's
 * view of the game folder; QuickBMS, a program of its own, sees the real disk (and writes
 * reach a mod's staged archive, as they did through a link). Vortex versions without virtual
 * deployment have no `util.realFilePath`, and their paths are real already.
 */
function realPath(filePath: string): string {
  const resolve = (util as { realFilePath?: (input: string) => string }).realFilePath;
  return resolve === undefined ? filePath : resolve(filePath);
}

function run(command: string, paths: string[], options: IQBMSOptions): Promise<void> {
  const parameters = paths.map(realPath);
  let timer: NodeJS.Timeout;
  let isClosed: boolean = false;
  let lastMessageReceived: number;
  let wstream;
  const createLog = !!options.createLog || command === "l";
  if (createLog) {
    wstream = fs.createWriteStream(LOG_FILE_PATH);
  }

  return new Promise<void>((resolve, reject) => {
    const args = commandArguments(command, parameters, options, FILTER_FILE_PATH);
    let process;
    try {
      process = spawn(path.join(__dirname, executableName()), args, {
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      if (wstream) wstream.close();
      return reject(err);
    }

    if (timer === undefined) {
      lastMessageReceived = Date.now();
      timer = setTimeout(() => checkTimer(), CHECK_TIME_MSEC);
    }

    const onNewMessage = () => {
      lastMessageReceived = Date.now();
    };

    const stdInErrs: string[] = [];
    const checkTimer = () => {
      if (lastMessageReceived + TIMEOUT_MSEC <= Date.now()) {
        process.kill();
        clearTimeout(timer);
        timer = undefined;
      } else {
        // We haven't received any messages back from the qbms process
        //  in 5 seconds. This is generally a sign that qbms is stuck.
        //  Hitting any keyboard key will revive the process (even when
        //  running it manually); we're going to attempt to simulate
        //  a spacebar key press which should force the process back into
        //  gear.
        if (!isClosed) {
          try {
            process.stdin.write("\x20", (err: Error) => {
              stdInErrs.push(JSON.stringify(err, undefined, 2));
            });
            timer = setTimeout(() => checkTimer(), CHECK_TIME_MSEC);
          } catch (err) {
            isClosed = true;
            log("error", "failed to send keep alive", err);
            clearTimeout(timer);
            timer = undefined;
          }
        } else {
          clearTimeout(timer);
          timer = undefined;
        }
      }
    };

    const stdOutLines: string[] = [];
    const stdErrLines: string[] = [];

    process.on("error", (err) => {
      isClosed = true;
      clearTimeout(timer);
      timer = undefined;
      if (wstream) {
        wstream.close();
        wstream = undefined;
      }
      return reject(err);
    });

    process.on("close", (code, signal) => {
      // stdio streams are now closed.
      isClosed = true;
      clearTimeout(timer);
      timer = undefined;
      if (signal === "SIGTERM") {
        if (!createLog) {
          // We timed out - We want this logged regardless of whether
          //  the create log switch has been provided!
          wstream = fs.createWriteStream(LOG_FILE_PATH);
        }
        const timeoutDump = [].concat(["QBMS has timed out!"], stdErrLines, stdOutLines, stdInErrs);
        timeoutDump.forEach((line) => wstream.write(line + "\n"));

        wstream.close();
        wstream = undefined;
        // tslint:disable-next-line: max-line-length
        return reject(
          new QuickBMSError(`quickbms(${signal}) - ${QUICK_BMS_ERRORMSG[14]}`, stdErrLines),
        );
      }

      if (!!wstream) {
        wstream.close();
        wstream = undefined;
      }

      if (code !== 0) {
        const errorMsg =
          code > QUICK_BMS_ERRORMSG.length - 1 ? QUICK_BMS_ERRORMSG[1] : QUICK_BMS_ERRORMSG[code];
        return reject(new QuickBMSError(`quickbms(${code}) - ` + errorMsg, stdErrLines));
      }

      const hasErrors = stdErrLines.find((line) => line.indexOf("Error:") !== -1) !== undefined;
      if (hasErrors) {
        return reject(new Error(stdErrLines.join("\n")));
      }
      return resolve();
    });

    process.stdout.on("data", (data) => {
      onNewMessage();
      const formatted = data.toString().split("\n");
      formatted.forEach((line) => {
        const formattedLine = line.replace(/\\/g, "/");
        stdOutLines.push(formattedLine);
        if (wstream) {
          wstream.write(formattedLine + "\n");
        }
      });
    });

    process.stderr.on("data", (data) => {
      onNewMessage();
      const formatted = data.toString().split("\n");
      formatted.forEach((line) => {
        stdErrLines.push(line);
      });
    });
  });
}

function createFiltersFile(wildCards: string[]): Promise<void> {
  return fs.ensureDirAsync(path.dirname(FILTER_FILE_PATH)).then(() =>
    fs
      .writeFileAsync(FILTER_FILE_PATH, wildCards.join("\n"))
      .then(() => Promise.resolve())
      .catch((err) => Promise.reject(err)),
  );
}

function removeFiltersFile(): Promise<void> {
  return fs
    .statAsync(FILTER_FILE_PATH)
    .then(() => fs.removeAsync(FILTER_FILE_PATH))
    .catch((err) => (err.code === "ENOENT" ? Promise.resolve() : Promise.reject(err)));
}

function reImport(props: IQBMSOpProps): Promise<void> {
  const { archivePath, bmsScriptPath, qbmsOptions, operationPath } = props;
  return validateArguments(archivePath, bmsScriptPath, operationPath, qbmsOptions)
    .then(() =>
      !!qbmsOptions.wildCards ? createFiltersFile(qbmsOptions.wildCards) : Promise.resolve(),
    )
    .then(() =>
      qbmsOptions.allowResize !== undefined
        ? Promise.resolve()
        : Promise.reject(new util.ArgumentInvalid("Re-import version was not specified")),
    )
    .then(() => run("w", [bmsScriptPath, archivePath, operationPath], qbmsOptions))
    .then(() => removeFiltersFile());
}

function extract(props: IQBMSOpProps): Promise<void> {
  const { archivePath, bmsScriptPath, qbmsOptions, operationPath } = props;
  return validateArguments(archivePath, bmsScriptPath, operationPath, qbmsOptions)
    .then(() => (!!qbmsOptions.wildCards ? createFiltersFile(qbmsOptions.wildCards) : undefined))
    .then(() => run(undefined, [bmsScriptPath, archivePath, operationPath], qbmsOptions))
    .then(() => removeFiltersFile());
}

function list(props: IQBMSOpProps): Promise<IListEntry[]> {
  const { archivePath, bmsScriptPath, qbmsOptions, operationPath } = props;
  return validateArguments(archivePath, bmsScriptPath, operationPath, qbmsOptions)
    .then(() =>
      !!qbmsOptions.wildCards ? createFiltersFile(qbmsOptions.wildCards) : Promise.resolve(),
    )
    .then(() => run("l", [bmsScriptPath, archivePath, operationPath], qbmsOptions))
    .then(() => removeFiltersFile())
    .then(() => fs.readFileAsync(LOG_FILE_PATH, { encoding: "utf-8" }))
    .then((data) => {
      const fileEntries: IListEntry[] = parseList(data, qbmsOptions.wildCards);
      return Promise.resolve(fileEntries);
    });
}

function write(props: IQBMSOpProps): Promise<void> {
  const { archivePath, bmsScriptPath, qbmsOptions, operationPath } = props;
  return validateArguments(archivePath, bmsScriptPath, operationPath, qbmsOptions).then(() =>
    run("w", [bmsScriptPath, archivePath, operationPath], qbmsOptions),
  );
}

export { reImport, list, write, extract };
