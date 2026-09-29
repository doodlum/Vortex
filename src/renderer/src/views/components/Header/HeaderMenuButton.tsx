import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { PopoverButton } from "@/ui/components/popover/PopoverButton";

interface IHeaderMenuButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  label: string;
  testId?: string;
}

/** Compact title-bar menu trigger: an icon followed by a dropdown chevron. */
export const HeaderMenuButton = forwardRef<HTMLButtonElement, IHeaderMenuButtonProps>(
  ({ icon, label, testId, ...props }, ref) => (
    <PopoverButton
      appearance="weak"
      aria-haspopup="menu"
      aria-label={label}
      brand="neutral"
      className="group h-7 w-11.5 gap-1 rounded-md border border-stroke-weak p-0 hover:bg-surface-low"
      customContent={
        <>
          <span className="flex size-5 items-center justify-center">{icon}</span>
          <span
            aria-hidden="true"
            className="h-1 w-2 bg-neutral-subdued group-hover:bg-neutral-strong"
            style={{
              WebkitMaskImage: 'url("assets/icons/menu-chevron.svg")',
              maskImage: 'url("assets/icons/menu-chevron.svg")',
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
            }}
          />
        </>
      }
      data-header-menu-button=""
      data-testid={testId}
      ref={ref}
      {...props}
    />
  ),
);

HeaderMenuButton.displayName = "HeaderMenuButton";
