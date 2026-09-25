import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Typography } from "@/ui/components/typography/Typography";

import { getIconPath } from "../iconMap";
import { NavigationButton } from "../Menu/NavigationButton";
import { usePanels } from "./PanelContext";

/** A new tab uses the same page picker whether it opens in an existing or new panel. */
export function PanelChooser({ panelId, tabId }: { panelId: string; tabId: string }) {
  const { t } = useTranslation();
  const { workspace, navigationPages, select } = usePanels();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector("button")?.focus();
  }, []);
  const openPages = new Set(
    Object.values(workspace.panels).flatMap((panel) => panel.tabs.map((tab) => tab.pageId)),
  );
  const availablePages = navigationPages.filter((page) => !openPages.has(page.id));
  return (
    <div
      ref={root}
      data-panel-chooser="tab"
      className="min-h-0 flex-1 overflow-auto bg-surface-base p-3"
    >
      <div className="flex w-49 flex-col gap-y-0.5 pt-1">
        {availablePages.map((page) => (
          <NavigationButton
            key={page.id}
            data-panel-choice={page.id}
            iconPath={page.mdi ?? getIconPath(page.icon)}
            className="w-full"
            onClick={() => select(panelId, tabId, page.id)}
          >
            {t(page.title, { ns: page.namespace })}
          </NavigationButton>
        ))}
      </div>
      {!availablePages.length && (
        <Typography appearance="subdued">{t("All pages are already open.")}</Typography>
      )}
    </div>
  );
}
