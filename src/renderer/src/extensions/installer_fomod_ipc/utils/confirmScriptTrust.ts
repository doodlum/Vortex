import path from "path";

import type { IExtensionApi } from "../../../types/api";
import { UserCanceled } from "../../../util/CustomErrors";
import type { IInstallationDetails } from "../../mod_management/types/InstallFunc";
import { getCSharpScriptAllowListForGame } from "../../mod_management/util/cSharpScriptAllowList";

/** Every C# execution path, including simulation, must obtain explicit consent. */
export async function confirmScriptTrust(
  api: IExtensionApi,
  gameId: string,
  archivePath?: string,
  details?: IInstallationDetails,
): Promise<void> {
  const allowList = getCSharpScriptAllowListForGame(gameId);
  if (allowList.has(details?.modReference?.repo?.modId || "")) return;
  const name = archivePath ?? "C# installer";
  const modName = details?.modReference?.id || path.basename(name, path.extname(name));
  const t = api.translate;
  const no = t("Cancel installation");
  const yes = t("Install anyway (unsafe)");
  const result = await api.showDialog?.(
    "question",
    t("Unsafe Mod Detected"),
    {
      bbcode: t(
        '"{{modName}}" contains C# scripts that can run code on your computer.[br][/br][br][/br]' +
          "These scripts give the mod full access to your system and can cause serious harm, including data loss or security breaches.[br][/br]" +
          "Unless you personally reviewed and trust the source, we strongly recommend you do not install this mod.[br][/br][br][/br]" +
          "Are you sure you want to continue?",
        { replace: { modName } },
      ),
    },
    [{ label: no }, { label: yes }],
  );
  if (result?.action !== yes) throw new UserCanceled();
}
