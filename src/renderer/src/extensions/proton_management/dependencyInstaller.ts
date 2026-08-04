import type PromiseBB from "bluebird";

import type { IExtensionApi } from "@/types/IExtensionContext";

const PROTONTRICKS_APP_ID = "com.github.Matoking.protontricks";

function runHost(api: IExtensionApi, command: string, args: string[]): PromiseBB<void> {
  return api.runExecutable(
    process.env.IS_FLATPAK === "true" ? "flatpak-spawn" : command,
    process.env.IS_FLATPAK === "true" ? ["--host", command, ...args] : args,
    { cwd: "/", expectSuccess: true, shell: false },
  );
}

export async function installDependencies(
  api: IExtensionApi,
  appId: string,
  verbs: string[],
): Promise<void> {
  if (verbs.length === 0) return;
  await runHost(api, "flatpak", ["info", PROTONTRICKS_APP_ID]).catch(() =>
    runHost(api, "flatpak", [
      "install",
      "--user",
      "--noninteractive",
      "-y",
      "flathub",
      PROTONTRICKS_APP_ID,
    ]),
  );
  await runHost(api, "flatpak", ["run", PROTONTRICKS_APP_ID, appId, ...verbs]);
}
