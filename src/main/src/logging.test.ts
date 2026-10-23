import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";
import winston from "winston";

vi.mock("./ipc", () => ({ betterIpcMain: { on: vi.fn() } }));

import { dropConsoleOnBrokenPipe, flushLogFile } from "./logging";

function makeLogger(): winston.LoggerInstance {
  return new winston.Logger({ transports: [new winston.transports.Console({ silent: true })] });
}

function pipeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: broken pipe, write`), { code });
}

describe("dropConsoleOnBrokenPipe", () => {
  it("stops logging to a console whose pipe broke", () => {
    const logger = makeLogger();
    const stdout = new EventEmitter();
    dropConsoleOnBrokenPipe(logger, [stdout]);

    stdout.emit("error", pipeError("EPIPE"));

    expect(logger.transports["console"]).toBeUndefined();
  });

  it("handles the error, so it doesn't reach the uncaught error handler", () => {
    const logger = makeLogger();
    const stderr = new EventEmitter();
    dropConsoleOnBrokenPipe(logger, [stderr]);

    // an emitter without an error listener throws
    expect(() => stderr.emit("error", pipeError("EPIPE"))).not.toThrow();
    expect(() => stderr.emit("error", pipeError("EPIPE"))).not.toThrow();
  });

  it("keeps the console for other stream errors", () => {
    const logger = makeLogger();
    const stdout = new EventEmitter();
    dropConsoleOnBrokenPipe(logger, [stdout]);

    stdout.emit("error", pipeError("EAGAIN"));

    expect(logger.transports["console"]).toBeDefined();
  });
});

describe("flushLogFile", () => {
  it("resolves once lines logged just before quitting are in the file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-log-flush-"));
    const filename = path.join(directory, "vortex.log");
    const logger = new winston.Logger({
      transports: [new winston.transports.File({ filename, json: false, level: "debug" })],
    });
    try {
      // The transport opens its file on the first write.
      const opened = new Promise((resolve) => logger.transports["file"]!.once("open", resolve));
      logger.info("start");
      await opened;
      for (let index = 0; index < 200; index++) logger.info(`line ${index}`);
      logger.info("clean application end");
      await flushLogFile(logger);
      expect(fs.readFileSync(filename, "utf8")).toContain("clean application end");
    } finally {
      logger.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does nothing without a file logger", async () => {
    await expect(flushLogFile(null)).resolves.toBeUndefined();
  });
});
