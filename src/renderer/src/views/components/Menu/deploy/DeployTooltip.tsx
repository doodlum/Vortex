import React, { type ReactElement } from "react";

import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";

import type { IDeployCopy } from "./deployCopy";

/** The tooltip every Deploy control design carries: what it does, then why, to the right. */
export const DeployTooltip = ({
  children,
  copy,
}: {
  children: ReactElement;
  copy: IDeployCopy;
}) => (
  <Tooltip
    customContent={
      <div className="max-w-64 space-y-1 px-4 py-3">
        <Typography appearance="moderate" as="p" className="font-semibold" typographyType="body-sm">
          {copy.title}
        </Typography>

        {!!copy.description && (
          <Typography appearance="subdued" as="p" typographyType="body-sm">
            {copy.description}
          </Typography>
        )}
      </div>
    }
    placement="right"
  >
    {children}
  </Tooltip>
);
