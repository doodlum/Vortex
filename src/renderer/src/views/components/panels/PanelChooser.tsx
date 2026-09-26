import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Typography } from "@/ui/components/typography/Typography";

import { getIconPath } from "../iconMap";
import { NavigationButton } from "../Menu/NavigationButton";
import { usePanels } from "./PanelContext";

/** A new panel shows the available pages from the current sidebar. */
export function PanelChooser({ panelId }: { panelId: string }) {
  const { t } = useTranslation();
  const { workspace, navigationPages, select } = usePanels();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("button")?.focus();
  }, []);
  const openPages = new Set(Object.values(workspace.panels).map((panel) => panel.pageId));
  const availablePages = navigationPages.filter((page) => !openPages.has(page.id));
  return (
    <div
      ref={root}
      data-panel-chooser="panel"
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-base p-3"
    >
      <div className="m-auto flex w-49 flex-col gap-y-0.5">
        {availablePages.map((page) => (
          <NavigationButton
            key={page.id}
            data-panel-choice={page.id}
            iconPath={page.mdi ?? getIconPath(page.icon)}
            className="w-full"
            onClick={() => select(panelId, page.id)}
          >
            {t(page.title, { ns: page.namespace })}
          </NavigationButton>
        ))}
        {!availablePages.length && (
          <Typography appearance="subdued">{t("All pages are already open.")}</Typography>
        )}
      </div>
    </div>
  );
}
