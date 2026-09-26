import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

interface INavigationButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: string;
  iconPath: string;
  labelContent?: ReactNode;
  isActive?: boolean;
  trailing?: ReactNode;
}

/** Shared navigation row for the sidebar and sidebar-style page pickers. */
export const NavigationButton = forwardRef<HTMLButtonElement, INavigationButtonProps>(
  ({ children, iconPath, labelContent, isActive, trailing, className, ...props }, ref) => (
    <button
      ref={ref}
      className={joinClasses([
        "relative flex h-10 items-center rounded-lg text-left transition-colors",
        labelContent ? "" : "gap-x-3 px-3",
        "hover:bg-surface-mid hover:text-neutral-moderate focus-visible:z-1",
        isActive ? "bg-surface-low text-neutral-moderate" : "text-neutral-subdued",
        className,
      ])}
      {...props}
    >
      {labelContent ?? (
        <>
          <Icon className="shrink-0" path={iconPath} size="sm" />
          <span className="min-w-0 grow">
            <Typography
              as="span"
              brand="none"
              className="block truncate font-semibold"
              typographyType="body-sm"
            >
              {children}
            </Typography>
          </span>
          {trailing}
        </>
      )}
    </button>
  ),
);
NavigationButton.displayName = "NavigationButton";
