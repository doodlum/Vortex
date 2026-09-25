import React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";

export function PanelNewTabButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label = t("Open new tab");
  return (
    <Tooltip content={label}>
      <Button
        appearance="weak"
        brand="neutral"
        aria-label={label}
        data-panel-new-tab=""
        disabled={disabled}
        className="size-7 p-0"
        customContent={
          <img alt="" draggable={false} className="size-4" src="assets/panels/tab-add.svg" />
        }
        onClick={onClick}
      />
    </Tooltip>
  );
}
