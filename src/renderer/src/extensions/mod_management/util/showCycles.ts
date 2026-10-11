import shortid from "shortid";

import type { IExtensionApi } from "@/types/IExtensionContext";

export function showCycles(api: IExtensionApi, cycles: string[][], gameId: string) {
  const id = shortid();
  return api.showDialog(
    "error",
    "Cycles",
    {
      text:
        "Dependency rules between your mods contain cycles, " +
        'like "A after B" and "B after A". You need to remove one of the ' +
        "rules causing the cycle, otherwise your mods can't be " +
        "applied in the right order.",
      links: cycles.map((cycle, idx) => ({
        label: cycle.join(", "),
        action: () => {
          api.closeDialog(id);
          api.events.emit("edit-mod-cycle", gameId, cycle);
        },
      })),
    },
    [{ label: "Close" }],
    id,
  );
}
