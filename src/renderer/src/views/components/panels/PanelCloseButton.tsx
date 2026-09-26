import React from "react";

import { Button } from "@/ui/components/button/Button";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";

export function PanelCloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <Button
        appearance="subdued"
        brand="neutral"
        aria-label={label}
        className="size-7 p-0"
        customContent={
          <img alt="" draggable={false} className="size-4" src="assets/panels/close.svg" />
        }
        onClick={onClick}
      />
    </Tooltip>
  );
}
