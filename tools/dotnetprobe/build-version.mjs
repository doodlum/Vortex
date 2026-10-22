import { execFileSync } from "node:child_process";

// Nx evaluates runtime inputs even for a no-op target. Linux must not invoke .NET.
const version =
  process.platform === "win32"
    ? execFileSync("dotnet", ["--version"], { encoding: "utf8" }).trim()
    : `not-required-${process.platform}`;
console.log(version);
