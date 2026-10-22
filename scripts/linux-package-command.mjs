import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/** Keep the tool and its children owned until exit, including interruption and timeout. */
export async function runCommand(command, args, { cwd, env, log, timeoutMs = 1_800_000 }) {
  const fd = openSync(log, "wx", 0o600);
  let interrupt;
  let timer;
  let killTimer;
  let processId;
  let failed = false;
  let cleanupFailure;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", fd, fd],
        detached: process.platform !== "win32",
      });
      processId = child.pid;
      let failure;
      const kill = (signal) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") failure ??= error;
        }
      };
      interrupt = (reason = "interrupted") => {
        failure ??= new Error(`${command} ${reason}; see ${log}`);
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 5_000);
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      timer = setTimeout(() => interrupt("timed out"), timeoutMs);
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code, signal) => {
        if (failure || code !== 0) {
          failed = true;
          kill("SIGTERM");
          reject(failure ?? new Error(`${command} exited ${code ?? signal}; see ${log}`));
        } else resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    try {
      if (failed && processId && process.platform !== "win32") {
        // The direct child can exit while a compressor remains in its process group.
        // Keep ownership until that group is gone, rather than clearing its kill timer early.
        let alive = () => {
          try {
            process.kill(-processId, 0);
            return true;
          } catch (error) {
            if (error.code === "ESRCH") return false;
            throw error;
          }
        };
        for (const signal of ["SIGTERM", "SIGKILL"]) {
          if (!alive()) break;
          try {
            process.kill(-processId, signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          const deadline = Date.now() + 5_000;
          while (alive() && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (alive())
          throw new Error(
            `Packaging process group ${processId} remains after cancellation; inspect it before retrying`,
          );
      }
    } catch (error) {
      cleanupFailure = error;
    }
    if (interrupt) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    closeSync(fd);
    if (cleanupFailure) throw cleanupFailure;
  }
}
