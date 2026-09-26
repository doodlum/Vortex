import { PopoverButton } from "@headlessui/react";
import { useRef, type ReactNode, type MouseEvent, type KeyboardEvent } from "react";

import { Popover } from "@/ui/components/popover/Popover";
import { PopoverMenu } from "@/ui/components/popover/PopoverMenu";
import type { IMenuAction } from "@/ui/components/popover/PopoverMenuItem";
import { PopoverPanel } from "@/ui/components/popover/PopoverPanel";

/** Context-menu entry point using the same accessible menu as the profile button. */
export function PanelActionMenu({
  label,
  actions,
  children,
}: {
  label: string;
  actions: IMenuAction[][];
  children: (props: {
    onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  }) => ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement>();
  const open = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    opener.current = event.currentTarget;
    if (trigger.current?.getAttribute("aria-expanded") !== "true") trigger.current?.click();
  };
  return (
    <Popover className="relative min-w-0">
      {({ close }) => (
        <>
          <PopoverButton
            ref={trigger}
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none absolute inset-0 opacity-0"
          />
          {children({
            onContextMenu: open,
            onKeyDown: (event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
                open(event);
            },
          })}
          <PopoverPanel
            anchor={{ to: "bottom start", gap: 4 }}
            className="nxm-popover-panel-dropdown min-w-56"
            onKeyDownCapture={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(opener.current);
              }
            }}
          >
            <PopoverMenu label={label} actions={actions} onSelect={() => close(opener.current)} />
          </PopoverPanel>
        </>
      )}
    </Popover>
  );
}
import React from "react";
