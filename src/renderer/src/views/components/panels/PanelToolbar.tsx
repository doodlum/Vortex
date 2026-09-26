import { PopoverButton } from "@headlessui/react";
import React, { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Popover } from "@/ui/components/popover/Popover";
import { PopoverMenu } from "@/ui/components/popover/PopoverMenu";
import { PopoverPanel } from "@/ui/components/popover/PopoverPanel";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import {
  closePanel,
  defaultPlacement,
  panelBounds,
  panelPlacements,
  previewPanelPlacement,
  type PanelNode,
  type PanelPosition,
} from "@/util/panelLayout";

import { usePanels } from "./PanelContext";

export const positionNames: Record<PanelPosition, string> = {
  right: "Right column",
  left: "Left column",
  bottom: "Bottom row",
  top: "Top row",
  "top-right": "Top right",
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
  "top-left": "Top left",
};

export function PositionIcon({
  root,
  newPanelId = "__new-panel",
  size = "md",
}: {
  root: PanelNode;
  newPanelId?: string;
  size?: "sm" | "md";
}) {
  return (
    <svg
      data-panel-icon-preview=""
      aria-hidden="true"
      className={size === "sm" ? "size-4 shrink-0" : "size-6 shrink-0"}
      viewBox="0 0 30 30"
    >
      {panelBounds(root).map(({ id, x, y, width, height }) => {
        const proposed = id === newPanelId;
        return (
          <rect
            key={id}
            data-panel-icon-cell={id}
            x={x * 30 + 1.25}
            y={y * 30 + 1.25}
            width={Math.max(1, width * 30 - 2.5)}
            height={Math.max(1, height * 30 - 2.5)}
            rx="2"
            fill={proposed ? "currentColor" : "none"}
            stroke={proposed ? "none" : "currentColor"}
            strokeWidth="2"
          />
        );
      })}
    </svg>
  );
}

export function PanelToolbar() {
  const { t } = useTranslation();
  const { workspace, add, isHorizontal } = usePanels();
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = Object.values(workspace.panels).find((panel) => !panel.pageId);
  const root = pending ? closePanel(workspace, pending.id).root : workspace.root;
  const placements = panelPlacements(root);
  const position = pending?.placement ?? defaultPlacement(root, isHorizontal);
  const candidate = placements.find((placement) => placement.position === position);
  const preview = pending
    ? workspace.root
    : candidate
      ? previewPanelPlacement(root, candidate)
      : root;
  const prioritized = [...placements].sort(
    (a, b) => Number(b.position === position) - Number(a.position === position),
  );
  return (
    <Popover className="relative flex h-10 shrink-0" style={{ WebkitAppRegion: "no-drag" }}>
      {({ close }) => (
        <>
          <Tooltip
            content={t("Add panel: {{position}}", {
              position: t(positionNames[position ?? "right"]),
            })}
          >
            <Button
              appearance="weak"
              brand="neutral"
              aria-label={t("Add panel")}
              aria-pressed={!!pending}
              aria-disabled={!placements.length || !!pending}
              data-panel-next-position={position ?? "full"}
              className="h-10 rounded-r-none border border-stroke-weak px-2"
              customContent={<PositionIcon root={preview} newPanelId={pending?.id} />}
              onClick={() => {
                if (!pending) add();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                trigger.current?.click();
              }}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  trigger.current?.click();
                }
              }}
            />
          </Tooltip>
          <PopoverButton
            ref={trigger}
            aria-label={t("Choose panel position")}
            aria-haspopup="menu"
            className="flex h-10 w-6.5 items-center justify-center rounded-r-lg border-y border-r border-stroke-weak hover:bg-surface-mid disabled:opacity-40"
          >
            <img alt="" draggable={false} src="assets/panels/layout-chevron.svg" />
          </PopoverButton>
          <PopoverPanel
            anchor={{ to: "bottom end", gap: 4 }}
            className="nxm-popover-panel-dropdown min-w-56"
          >
            <PopoverMenu
              label={t("Panel position")}
              actions={[
                prioritized.map((placement) => ({
                  label: t(positionNames[placement.position]),
                  icon: <PositionIcon root={previewPanelPlacement(root, placement)} size="sm" />,
                  onClick: () => add(placement.position),
                })),
              ]}
              onSelect={() => close()}
            />
          </PopoverPanel>
        </>
      )}
    </Popover>
  );
}
