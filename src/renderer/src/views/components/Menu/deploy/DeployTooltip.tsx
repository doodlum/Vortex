import React, { type ReactElement } from "react";

import { Button } from "@/ui/components/button/Button";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";

import type { IDeployCopy } from "./deployCopy";

/** What the control's tooltip says: its title, the notification's lines, its More. */
export const DeployTooltipContent = ({
  copy,
  padded = true,
}: {
  copy: IDeployCopy;
  /** Off where the tooltip it sits in pads it already. */
  padded?: boolean;
}) => (
  <div
    className={joinClasses(["max-w-64 space-y-1"], { "px-4 py-3": padded })}
    data-testid="deploy-tooltip"
  >
    <Typography appearance="moderate" as="p" className="font-semibold" typographyType="body-sm">
      {copy.title}
    </Typography>

    {copy.lines.map((line) => (
      <Typography appearance="subdued" as="p" key={line} typographyType="body-sm">
        {line}
      </Typography>
    ))}

    {copy.more !== undefined && (
      <div className="pt-1">
        <Button appearance="moderate" brand="neutral" size="sm" onClick={copy.more.action}>
          {copy.more.label}
        </Button>
      </div>
    )}
  </div>
);

/**
 * The tooltip every Deploy control design carries, to the right. It lets the pointer in
 * when it holds a button.
 */
export const DeployTooltip = ({
  children,
  copy,
}: {
  children: ReactElement;
  copy: IDeployCopy;
}) => (
  <Tooltip
    customContent={<DeployTooltipContent copy={copy} />}
    interactive={copy.more !== undefined}
    placement="right"
  >
    {children}
  </Tooltip>
);
