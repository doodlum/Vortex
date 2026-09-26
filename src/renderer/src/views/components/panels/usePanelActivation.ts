import { useLayoutEffect, useRef } from "react";

export function usePanelActivation(panelId: string, activate: (panelId: string) => void) {
  const frame = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const handleActivation = () => activate(panelId);
    // Page portals are React siblings of the frame. Native capture follows their DOM
    // placement and also reaches controls that stop propagation inside the page.
    node.addEventListener("pointerdown", handleActivation, true);
    node.addEventListener("focusin", handleActivation, true);
    return () => {
      node.removeEventListener("pointerdown", handleActivation, true);
      node.removeEventListener("focusin", handleActivation, true);
    };
  }, [panelId, activate]);

  return frame;
}
