import React, { type ButtonHTMLAttributes, type ComponentType } from "react";

import { useWindowContext } from "@/contexts";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";

import { NavigationButton } from "./NavigationButton";

interface IMenuButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: string;
  iconPath: string;
  isActive?: boolean;
  Badge?: ComponentType<React.PropsWithChildren<unknown>>;
}
export function MenuButton({ children, Badge, ...props }: IMenuButtonProps) {
  const { menuIsCollapsed } = useWindowContext();
  return (
    <Tooltip content={children} disabled={!menuIsCollapsed} placement="right">
      <NavigationButton aria-label={children} trailing={Badge ? <Badge /> : undefined} {...props}>
        {children}
      </NavigationButton>
    </Tooltip>
  );
}
