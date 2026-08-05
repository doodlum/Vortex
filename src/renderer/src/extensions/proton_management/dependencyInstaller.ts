import type PromiseBB from "bluebird";

import type { IExtensionApi } from "@/types/IExtensionContext";

const PROTONTRICKS_APP_ID = "com.github.Matoking.protontricks";

export type DependencyProgress = (progress: number, message: string) => void;

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
  onProgress?: DependencyProgress,
): Promise<void> {
  if (verbs.length === 0) return;
  onProgress?.(5, "Checking Proton dependency support");
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
  // Winetricks recipes contain checksums for vendor redistributables. Vendors update those files,
  // so an old Protontricks can reject an authentic current installer and silently leave a prefix
  // without the dependency Vortex requested. Refresh the helper before relying on its result.
  onProgress?.(20, "Installing or updating Protontricks");
  await runHost(api, "flatpak", ["update", "--noninteractive", "-y", PROTONTRICKS_APP_ID]);
  onProgress?.(55, `Installing ${verbs.join(", ")}`);
  await runHost(api, "flatpak", ["run", PROTONTRICKS_APP_ID, appId, ...verbs]);
  onProgress?.(100, "Windows dependencies installed");
}
