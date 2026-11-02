import { realpath } from "node:fs/promises";
import * as path from "node:path";

export interface ISteamRuntimeLaunch {
  protonPath: string;
  runtimePath: string;
  libraryPaths: string[];
  gamePath: string;
  compatDataPath: string;
  executable: string;
  cwd: string;
  extraWritePaths?: string[];
}

const inside = (root: string, target: string) => target === root || target.startsWith(root + "/");

function representable(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!path.posix.isAbsolute(value) || /[:\0\r\n]/.test(value))
    throw new Error(
      "Steam Runtime paths must be absolute and cannot contain colons or control characters.",
    );
  if (
    normalized === "/" ||
    [
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib32",
      "/lib64",
      "/libx32",
      "/etc",
      "/proc",
      "/sys",
      "/dev",
      "/run/host",
    ].some((root) => inside(root, normalized))
  )
    throw new Error(
      `Steam Runtime cannot expose this host path unchanged: ${value}. Move the game/tool to a Steam library or a user-owned directory.`,
    );
  return normalized;
}

/** Share only selected installations and the launched tool/cwd, including symlink targets. */
export async function steamRuntimeLaunchEnvironment(
  input: ISteamRuntimeLaunch,
  canonicalize: (file: string) => Promise<string> = realpath,
): Promise<Record<string, string>> {
  const variants = async (file: string) => {
    const logical = representable(file);
    const physical = representable(await canonicalize(logical));
    return [...new Set([logical, physical])];
  };
  const tools = [
    ...new Set((await Promise.all([input.protonPath, input.runtimePath].map(variants))).flat()),
  ];
  const installs = await Promise.all(
    [input.gamePath, input.protonPath, input.runtimePath].map(variants),
  );
  const libraries: string[] = [];
  for (const library of input.libraryPaths) {
    // Only libraries involved in this launch; never export unrelated volumes.
    const apps = path.posix.join(library, "steamapps");
    let candidates: string[];
    try {
      candidates = [...new Set([apps, await canonicalize(apps)])];
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    if (installs.flat().some((install) => candidates.some((root) => inside(root, install))))
      libraries.push(...candidates.map(representable));
  }
  const shared = [
    ...tools,
    ...libraries,
    ...(await variants(input.gamePath)),
    ...(await variants(input.compatDataPath)),
  ];
  const extra = [
    ...(await variants(input.cwd)),
    ...(await Promise.all((input.extraWritePaths ?? []).map(variants))).flat(),
  ];
  // Prefix-internal Windows paths need no additional host mount.
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(input.executable)) {
    extra.push(...(await variants(path.posix.dirname(input.executable))));
    extra.push(
      ...(await variants(path.posix.dirname(await canonicalize(representable(input.executable))))),
    );
  }
  const mounts = [...new Set(extra.filter((file) => !shared.some((root) => inside(root, file))))];
  return {
    STEAM_COMPAT_TOOL_PATHS: tools.join(":"),
    STEAM_COMPAT_LIBRARY_PATHS: [...new Set(libraries)].join(":"),
    PRESSURE_VESSEL_FILESYSTEMS_RW: mounts.join(":"),
  };
}
