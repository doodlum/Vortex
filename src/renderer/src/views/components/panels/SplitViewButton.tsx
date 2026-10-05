import { mdiDockRight } from "@mdi/js";
import React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";

interface ISplitViewButtonProps {
  isSplit: boolean;
  closePageName: string;
  disabled?: boolean;
  onClick: () => void;
}

/** A modern page owns the right-hand split control in its header corner. */
export function SplitViewButton({
  isSplit,
  closePageName,
  disabled = false,
  onClick,
}: ISplitViewButtonProps) {
  const { t } = useTranslation();
  const label = isSplit ? t("Close {{page}}", { page: closePageName }) : t("Enter split view");
  return (
    <Tooltip content={label}>
      <Button
        appearance="subdued"
        brand="neutral"
        aria-label={label}
        aria-pressed={isSplit}
        className={
          isSplit
            ? "size-7 border-stroke-moderate bg-surface-translucent-mid p-0 text-neutral-strong"
            : "size-7 p-0"
        }
        customContent={<Icon path={mdiDockRight} size="sm" />}
        data-split-view-toggle=""
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );
}
