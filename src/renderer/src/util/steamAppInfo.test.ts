import { describe, expect, test } from "vitest";

import { findSteamLaunchOption, readAppInfo, splitLaunchArguments } from "./steamAppInfo";

type Tree = { [key: string]: Tree | string | number };

/** Binary key-values as Steam writes them; names inline (v27/28) or as table indices (v29). */
function keyValues(tree: Tree, table?: string[]): Buffer {
  const parts: Buffer[] = [];
  const name = (key: string) => {
    if (table === undefined) {
      return Buffer.from(key + "\0", "utf8");
    }
    let index = table.indexOf(key);
    if (index < 0) {
      index = table.push(key) - 1;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32LE(index);
    return out;
  };
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "object") {
      parts.push(Buffer.from([0x00]), name(key), keyValues(value, table));
    } else if (typeof value === "string") {
      parts.push(Buffer.from([0x01]), name(key), Buffer.from(value + "\0", "utf8"));
    } else {
      const out = Buffer.alloc(4);
      out.writeInt32LE(value);
      parts.push(Buffer.from([0x02]), name(key), out);
    }
  }
  parts.push(Buffer.from([0x08]));
  return Buffer.concat(parts);
}

function appInfoFile(version: 27 | 28 | 29, apps: Record<number, Tree>): Buffer {
  const table: string[] | undefined = version === 29 ? [] : undefined;
  const header = Buffer.alloc(version === 29 ? 16 : 8);
  header.writeUInt32LE({ 27: 0x07564427, 28: 0x07564428, 29: 0x07564429 }[version], 0);
  header.writeUInt32LE(1, 4);
  const entries: Buffer[] = [];
  for (const [appId, tree] of Object.entries(apps)) {
    const fixed = Buffer.alloc(4 + 4 + 8 + 20 + 4 + (version === 27 ? 0 : 20));
    const body = Buffer.concat([fixed, keyValues({ appinfo: tree }, table)]);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(Number(appId), 0);
    head.writeUInt32LE(body.length, 4);
    entries.push(head, body);
  }
  const end = Buffer.alloc(4);
  const data = Buffer.concat([header, ...entries, end]);
  if (table === undefined) {
    return data;
  }
  data.writeBigInt64LE(BigInt(data.length), 8);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(table.length);
  return Buffer.concat([data, count, ...table.map((s) => Buffer.from(s + "\0", "utf8"))]);
}

// Halo MCC's launch entries as Steam caches them (2026-10).
const MCC: Tree = {
  appid: 976730,
  config: {
    installdir: "Halo The Master Chief Collection",
    launch: {
      "0": { executable: "mcclauncher.exe", type: "option1" },
      "1": {
        executable: "mcc\\binaries\\win64\\mcc-win64-shipping.exe",
        arguments: "-no-eac",
        type: "option2",
      },
      "2": {
        executable: "mcc\\binaries\\win64\\mcc.exe",
        type: "option3",
        config: { BetaKey: "dailybuild-main" },
      },
    },
  },
};

const OTHER: Tree = {
  config: {
    launch: {
      "0": { executable: "linux/game.sh", type: "default", config: { oslist: "linux" } },
      "1": { executable: "game.exe", type: "default", config: { oslist: "windows" } },
      "2": { executable: "tool.exe", arguments: '-path "C:\\a b" -x', type: "option2" },
    },
  },
};

describe.each([27, 28, 29] as const)("appinfo.vdf v%i", (version) => {
  const file = appInfoFile(version, { 400: OTHER, 976730: MCC });
  const read = async () => file;

  test("finds an app among others and reads its sections", () => {
    expect(readAppInfo(file, 976730)?.appid).toBe(976730);
    expect(readAppInfo(file, 1)).toBeUndefined();
  });

  test("the launch entry of a Steam option, with its arguments", async () => {
    await expect(findSteamLaunchOption(read, "steam", 976730, "option2", "win32")).resolves.toEqual(
      {
        executable: "mcc\\binaries\\win64\\mcc-win64-shipping.exe",
        arguments: ["-no-eac"],
        workingdir: undefined,
      },
    );
    await expect(findSteamLaunchOption(read, "steam", 976730, "option9", "win32")).resolves.toBe(
      undefined,
    );
  });

  test("an entry for another OS is skipped", async () => {
    await expect(findSteamLaunchOption(read, "steam", 400, "default", "win32")).resolves.toEqual({
      executable: "game.exe",
      arguments: [],
      workingdir: undefined,
    });
    await expect(findSteamLaunchOption(read, "steam", 400, "default", "linux")).resolves.toEqual({
      executable: "linux/game.sh",
      arguments: [],
      workingdir: undefined,
    });
  });
});

test("an unknown format, a truncated file or no file finds nothing", async () => {
  const file = appInfoFile(29, { 976730: MCC });
  expect(readAppInfo(Buffer.from("not a cache"), 976730)).toBeUndefined();
  expect(readAppInfo(file.subarray(0, 40), 976730)).toBeUndefined();
  await expect(
    findSteamLaunchOption(
      () => Promise.reject(new Error("ENOENT")),
      "steam",
      976730,
      "option2",
      "win32",
    ),
  ).resolves.toBeUndefined();
});

test("launch arguments split like a Windows command line, quotes removed", () => {
  expect(splitLaunchArguments('-path "C:\\a b" -x')).toEqual(["-path", "C:\\a b", "-x"]);
  expect(splitLaunchArguments('  -a   ""  b ')).toEqual(["-a", "", "b"]);
  expect(splitLaunchArguments("")).toEqual([]);
});
