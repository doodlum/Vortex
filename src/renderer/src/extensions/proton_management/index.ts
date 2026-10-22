import type { IExtensionContext } from "@/types/IExtensionContext";

import { activeProtonGame } from "./selection";
import { ProtonPage } from "./views/ProtonPage";

function init(context: IExtensionContext): boolean {
  if (process.platform !== "linux") return true;
  context.registerMainPage("proton", "Proton", ProtonPage, {
    priority: 55,
    group: "per-game",
    newLayout: true,
    visible: () => activeProtonGame(context.api.getState()) !== undefined,
    props: () => ({ api: context.api }),
  });
  return true;
}

export default init;
