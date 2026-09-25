import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Tooltip } from "@/ui/components/tooltip/Tooltip";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import { activePage, MAX_TABS, type IPanel } from "@/util/panelLayout";

import { getIconPath } from "../iconMap";
import { usePanels } from "./PanelContext";

export function PanelTabs({ panel }: { panel: IPanel }) {
  const { t } = useTranslation();
  const { workspace, pages, activate, close, newTab } = usePanels();
  const scroll = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const multiple = panel.tabs.length > 1;
  const blankPanel = !multiple && !activePage(panel);
  const focusedPage = pages.find((page) => page.id === activePage(panel));
  const panelLabel = focusedPage
    ? t(focusedPage.title, { ns: focusedPage.namespace })
    : t("New tab");
  const measure = () => {
    const node = scroll.current;
    if (node)
      setEdges({
        left: node.scrollLeft > 1,
        right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      });
  };
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [panel.tabs.length]);
  useEffect(() => {
    scroll.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    measure();
  }, [panel.activeTab]);
  const overflow = edges.left || edges.right;
  const action = (label: string, asset: string, onClick: () => void, disabled = false) => (
    <Tooltip content={label}>
      <Button
        appearance="weak"
        brand="neutral"
        aria-label={label}
        disabled={disabled}
        className="size-7 p-0"
        customContent={
          <img alt="" draggable={false} className="size-4" src={`assets/panels/${asset}.svg`} />
        }
        onClick={onClick}
      />
    </Tooltip>
  );
  return (
    <div
      data-panel-tabbar=""
      className="flex h-10 min-w-0 shrink-0 items-center rounded-t-lg border-b border-stroke-weak bg-surface-panel-bar"
    >
      {overflow && (
        <div className="pl-3">
          {action(
            t("Scroll tabs left"),
            "scroll-left",
            () => scroll.current?.scrollBy({ left: -232, behavior: "smooth" }),
            !edges.left,
          )}
        </div>
      )}
      <div
        ref={scroll}
        role="tablist"
        aria-label={t("Panel tabs")}
        className="flex h-full min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto"
        onScroll={measure}
      >
        {panel.tabs.map((tab, index) => {
          const page = pages.find((entry) => entry.id === tab.pageId);
          const label = page ? t(page.title, { ns: page.namespace }) : tab.pageId || t("New tab");
          const selected = tab.id === panel.activeTab;
          return (
            <div
              key={tab.id}
              className={joinClasses([
                "relative flex h-full min-w-25 max-w-58 shrink-0 items-center gap-3 px-3",
                selected
                  ? "bg-surface-low text-neutral-moderate"
                  : "text-neutral-subdued hover:bg-surface-mid",
              ])}
            >
              <button
                type="button"
                role="tab"
                id={`panel-tab-${tab.id}`}
                aria-controls={`panel-content-${panel.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="flex h-full min-w-0 flex-1 items-center gap-3 focus-visible:outline-2 focus-visible:outline-focus-subdued"
                onClick={() => activate(panel.id, tab.id)}
                onKeyDown={(event) => {
                  if (event.key === "Delete" && multiple) {
                    event.preventDefault();
                    const doc = event.currentTarget.ownerDocument;
                    const next = panel.tabs[index === 0 ? 1 : index - 1].id;
                    close(panel.id, tab.id);
                    requestAnimationFrame(() => doc.getElementById(`panel-tab-${next}`)?.focus());
                    return;
                  }
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % panel.tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + panel.tabs.length - 1) % panel.tabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? panel.tabs.length - 1
                            : undefined;
                  if (next !== undefined) {
                    event.preventDefault();
                    activate(panel.id, panel.tabs[next].id);
                    event.currentTarget.ownerDocument
                      .getElementById(`panel-tab-${panel.tabs[next].id}`)
                      ?.focus();
                  }
                }}
              >
                {page ? (
                  <Icon path={page.mdi ?? getIconPath(page.icon)} size="sm" />
                ) : (
                  <img
                    alt=""
                    draggable={false}
                    className="size-4 shrink-0"
                    src="assets/panels/tab.svg"
                  />
                )}
                <Typography
                  as="span"
                  brand="none"
                  typographyType="body-sm"
                  className="block truncate font-semibold"
                >
                  {label}
                </Typography>
              </button>
              {multiple && (
                <button
                  type="button"
                  aria-label={t("Close {{page}} tab", { page: label })}
                  className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-surface-high"
                  onClick={() => close(panel.id, tab.id)}
                >
                  <img alt="" draggable={false} className="size-4" src="assets/panels/close.svg" />
                </button>
              )}
              <span
                aria-hidden="true"
                className={
                  selected && (multiple || blankPanel)
                    ? "absolute inset-y-0 right-0 w-px bg-stroke-weak"
                    : "absolute top-2 right-0 h-6 w-px bg-stroke-weak"
                }
              />
            </div>
          );
        })}
      </div>
      <div data-panel-actions="" className="flex h-full shrink-0 items-center gap-2 px-3">
        {overflow &&
          action(
            t("Scroll tabs right"),
            "scroll-right",
            () => scroll.current?.scrollBy({ left: 232, behavior: "smooth" }),
            !edges.right,
          )}
        {!blankPanel &&
          action(
            t("Open new tab"),
            "tab-add",
            () => newTab(panel.id),
            panel.tabs.length >= MAX_TABS,
          )}
        {Object.keys(workspace.panels).length > 1 &&
          (blankPanel || !!activePage(panel)) &&
          action(
            blankPanel ? t("Close new panel") : t("Close {{page}} panel", { page: panelLabel }),
            "close",
            () => close(panel.id),
          )}
      </div>
    </div>
  );
}
