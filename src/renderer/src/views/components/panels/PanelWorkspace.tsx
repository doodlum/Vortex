import { mdiViewSplitVertical } from "@mdi/js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { usePagesContext } from "@/contexts";
import type { IMainPage } from "@/types/IMainPage";
import { Button } from "@/ui/components/button/Button";
import { Icon } from "@/ui/components/icon/Icon";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import { activePage, panelIds, type IPanel, type PanelNode } from "@/util/panelLayout";

import { DNDContainer } from "../../DNDContainer";
import { MainPageContainer } from "../../MainPageContainer";
import { getIconPath } from "../iconMap";
import { PageHeaderActionsContext } from "../Page/PageHeader";
import { PanelChooser } from "./PanelChooser";
import { PanelCloseButton } from "./PanelCloseButton";
import { usePanels } from "./PanelContext";
import { usePanelActivation } from "./usePanelActivation";

/** Move a stable portal container, rather than remounting a page when a panel moves. */
function PanelPageHost({
  page,
  target,
  active,
  secondary,
  panelId,
  hasMultiplePanels,
  closePanel,
}: {
  page: IMainPage;
  target: HTMLElement | undefined;
  active: boolean;
  secondary: boolean;
  panelId: string | undefined;
  hasMultiplePanels: boolean;
  closePanel: (panelId: string) => void;
}) {
  const { t } = useTranslation();
  const container = useMemo(() => {
    const node = document.createElement("div");
    node.className =
      "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>.main-page]:min-h-0";
    node.dataset.panelPage = page.id;
    return node;
  }, [page.id]);
  useLayoutEffect(() => {
    if (target && container.parentElement !== target) target.appendChild(container);
  }, [target, container]);
  useEffect(() => () => container.remove(), [container]);
  const closeLabel = t("Close {{page}} panel", { page: t(page.title, { ns: page.namespace }) });
  const headerActions =
    panelId && hasMultiplePanels ? (
      <PanelCloseButton label={closeLabel} onClick={() => closePanel(panelId)} />
    ) : null;
  return createPortal(
    <PageHeaderActionsContext.Provider value={headerActions}>
      <MainPageContainer page={page} active={active} secondary={secondary} />
    </PageHeaderActionsContext.Provider>,
    container,
    page.id,
  );
}

function PanelFrame({
  panel,
  registerSlot,
}: {
  panel: IPanel;
  registerSlot: (id: string, node: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const { workspace, pages, focus, close } = usePanels();
  const frame = usePanelActivation(panel.id, focus);
  const pageId = activePage(panel);
  const page = pages.find((entry) => entry.id === pageId);
  const label = page ? t(page.title, { ns: page.namespace }) : pageId || t("New panel");
  const multi = Object.keys(workspace.panels).length > 1;
  const showPlainActions = page?.newLayout !== true;
  return (
    <section
      ref={frame}
      data-panel-id={panel.id}
      data-panel-focused={workspace.focusedPanel === panel.id}
      aria-label={t("{{page}} panel", { page: label })}
      className={joinClasses([
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-surface-low",
        multi && workspace.focusedPanel === panel.id
          ? "border-stroke-moderate"
          : "border-stroke-weak",
      ])}
    >
      {showPlainActions && (
        <div
          data-panel-plain-actions=""
          className="flex h-10 shrink-0 items-center justify-between border-b border-stroke-weak bg-surface-low px-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            {page ? (
              <Icon path={page.mdi ?? getIconPath(page.icon)} size="sm" />
            ) : (
              <Icon path={mdiViewSplitVertical} size="sm" />
            )}
            <Typography
              as="span"
              brand="none"
              typographyType="body-sm"
              className="block truncate font-semibold"
            >
              {label}
            </Typography>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {multi && (
              <PanelCloseButton
                label={pageId ? t("Close {{page}} panel", { page: label }) : t("Close new panel")}
                onClick={() => close(panel.id)}
              />
            )}
          </div>
        </div>
      )}
      <div
        id={`panel-content-${panel.id}`}
        role="region"
        aria-label={label}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {!pageId ? (
          <PanelChooser panelId={panel.id} />
        ) : !page ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Typography>{t("This page is unavailable for the current game.")}</Typography>
            <Typography appearance="subdued">{label}</Typography>
          </div>
        ) : (
          <div
            ref={(node) => registerSlot(panel.id, node)}
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          />
        )}
      </div>
    </section>
  );
}

function PanelTree({
  node,
  registerSlot,
}: {
  node: PanelNode;
  registerSlot: (id: string, node: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const { workspace, resize } = usePanels();
  const root = useRef<HTMLDivElement>(null);
  if (node.kind === "panel")
    return <PanelFrame panel={workspace.panels[node.id]} registerSlot={registerSlot} />;
  const horizontal = node.axis === "x";
  const clamp = (ratio: number) => {
    const bounds = root.current?.getBoundingClientRect();
    const minimum = bounds
      ? Math.min(45, Math.max(20, (horizontal ? 280 / bounds.width : 160 / bounds.height) * 100))
      : 20;
    return Math.max(minimum, Math.min(100 - minimum, ratio));
  };
  return (
    <div
      ref={root}
      data-panel-split={node.id}
      className={joinClasses([
        "flex h-full min-h-0 min-w-0 flex-1",
        horizontal ? "flex-row" : "flex-col",
      ])}
    >
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${node.ratio} 1 0%` }}>
        <PanelTree node={node.first} registerSlot={registerSlot} />
      </div>
      <button
        type="button"
        role="separator"
        aria-label={t(horizontal ? "Resize panel columns" : "Resize panel rows")}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(node.ratio)}
        className={joinClasses([
          "flex shrink-0 touch-none items-center justify-center border-0 bg-surface-base text-neutral-weak hover:text-neutral-strong focus-visible:text-neutral-strong",
          horizontal ? "w-3 cursor-ew-resize" : "h-3 cursor-ns-resize",
        ])}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const bounds = root.current?.getBoundingClientRect();
          if (bounds)
            resize(
              node.id,
              clamp(
                100 *
                  (horizontal
                    ? (event.clientX - bounds.left) / bounds.width
                    : (event.clientY - bounds.top) / bounds.height),
              ),
            );
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onDoubleClick={() => resize(node.id, 50)}
        onKeyDown={(event) => {
          const back = horizontal ? "ArrowLeft" : "ArrowUp";
          const forward = horizontal ? "ArrowRight" : "ArrowDown";
          if ([back, forward, "Home", "End"].includes(event.key)) {
            event.preventDefault();
            resize(
              node.id,
              clamp(
                event.key === "Home"
                  ? 20
                  : event.key === "End"
                    ? 80
                    : node.ratio + (event.key === back ? -5 : 5),
              ),
            );
          }
        }}
      >
        <img
          alt=""
          draggable={false}
          src="assets/panels/drag-handle.svg"
          className={horizontal ? "pointer-events-none -rotate-90" : "pointer-events-none"}
        />
      </button>
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `${100 - node.ratio} 1 0%` }}
      >
        <PanelTree node={node.second} registerSlot={registerSlot} />
      </div>
    </div>
  );
}

export function PanelWorkspace() {
  const { t } = useTranslation();
  const { mainPages } = usePagesContext();
  const { workspace, focus, close, setOrientation } = usePanels();
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [slots, setSlots] = useState<Record<string, HTMLDivElement>>({});
  const slotRefs = useRef<Record<string, HTMLDivElement>>({});
  const [parking, setParking] = useState<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState<string[]>([]);
  const openPages = Object.values(workspace.panels)
    .map((panel) => panel.pageId)
    .filter(Boolean);
  const pagesKey = openPages.join("\n");
  useEffect(() => {
    setLoaded((current) => [...new Set([...current, ...pagesKey.split("\n").filter(Boolean)])]);
  }, [pagesKey]);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      setCompact(node.clientWidth < 720 || node.clientHeight < 360);
      setOrientation(node.clientWidth > node.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  // Callback refs are collected during commit, then published together before paint.
  useLayoutEffect(() => {
    const entries = Object.entries(slotRefs.current);
    if (
      entries.length !== Object.keys(slots).length ||
      entries.some(([id, element]) => slots[id] !== element)
    )
      setSlots({ ...slotRefs.current });
  });
  const registerSlot = (id: string, node: HTMLDivElement | null) => {
    if (node) slotRefs.current[id] = node;
    else delete slotRefs.current[id];
  };
  const ids = panelIds(workspace.root);
  const visibleId = workspace.focusedPanel;
  const visibleTree: PanelNode = compact ? { kind: "panel", id: visibleId } : workspace.root;
  const hostStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    position: "relative",
    minHeight: 0,
  };
  return (
    <div
      ref={root}
      data-panel-workspace=""
      className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {compact && ids.length > 1 && (
        <div
          role="group"
          aria-label={t("Visible panel")}
          className="mb-2 flex shrink-0 flex-wrap gap-1"
        >
          {ids.map((id, index) => {
            const page = mainPages.find((entry) => entry.id === activePage(workspace.panels[id]));
            return (
              <Button
                key={id}
                size="sm"
                brand="neutral"
                appearance={id === visibleId ? "subdued" : "weak"}
                aria-pressed={id === visibleId}
                onClick={() => focus(id)}
              >
                {page
                  ? t(page.title, { ns: page.namespace })
                  : t("Panel {{number}}", { number: index + 1 })}
              </Button>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DNDContainer style={hostStyle}>
          <PanelTree node={visibleTree} registerSlot={registerSlot} />
        </DNDContainer>
      </div>
      <div ref={setParking} style={{ display: "none" }} aria-hidden="true" />
      {mainPages
        .filter((page) => loaded.includes(page.id))
        .map((page) => {
          const owner = Object.values(workspace.panels).find(
            (panel) => activePage(panel) === page.id,
          );
          const target = owner ? slots[owner.id] : undefined;
          return (
            <PanelPageHost
              key={page.id}
              page={page}
              target={target ?? parking ?? undefined}
              active={!!target}
              secondary={owner?.id !== panelIds(workspace.root)[0]}
              panelId={owner?.id}
              hasMultiplePanels={ids.length > 1}
              closePanel={close}
            />
          );
        })}
    </div>
  );
}
import React from "react";
