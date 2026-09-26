import { mdiViewSplitVertical } from "@mdi/js";
import { useTranslation } from "react-i18next";

import type { IMainPage } from "@/types/IMainPage";
import { activePage, MAX_PANELS } from "@/util/panelLayout";

import { getIconPath } from "../iconMap";
import { PanelActionMenu } from "../panels/PanelActionMenu";
import { usePanels } from "../panels/PanelContext";
import { MenuButton } from "./MenuButton";

export function PanelNavigationItem({ page }: { page: IMainPage }) {
  const { t } = useTranslation();
  const { workspace, navigate } = usePanels();
  const open = Object.values(workspace.panels).some((panel) => panel.pageId === page.id);
  const focused = activePage(workspace.panels[workspace.focusedPanel]) === page.id;
  const label = t(page.title, { ns: page.namespace });
  return (
    <div data-panel-sidebar-page={page.id}>
      <PanelActionMenu
        label={t("Open {{page}}", { page: label })}
        actions={[
          [
            {
              label: t("Open in new panel"),
              iconPath: mdiViewSplitVertical,
              disabled: Object.keys(workspace.panels).length >= MAX_PANELS,
              onClick: () => navigate(page.id, "panel"),
            },
          ],
        ]}
      >
        {(props) => (
          <MenuButton
            {...props}
            Badge={page.menuBadge}
            iconPath={page.mdi ?? getIconPath(page.icon)}
            isActive={open}
            aria-current={focused ? "page" : undefined}
            className={focused ? "w-full ring-1 ring-stroke-moderate ring-inset" : "w-full"}
            onClick={(event) => navigate(page.id, event.ctrlKey ? "panel" : "current")}
          >
            {label}
          </MenuButton>
        )}
      </PanelActionMenu>
    </div>
  );
}
import React from "react";
