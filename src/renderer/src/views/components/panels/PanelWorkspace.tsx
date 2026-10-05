import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { usePagesContext } from "@/contexts";
import type { IMainPage } from "@/types/IMainPage";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import {
  activePage,
  fitSplitRatio,
  MIN_SPLIT_PANE_WIDTH,
  panelIds,
  SPLIT_GUTTER_WIDTH,
  type IPanel,
  type PanelNode,
} from "@/util/panelLayout";
import { isReduceMotionActive } from "@/util/reduceMotion";

import { DNDContainer } from "../../DNDContainer";
import { MainPageContainer } from "../../MainPageContainer";
import { PageHeaderActionsContext } from "../Page/PageHeader";
import { PanelChooser } from "./PanelChooser";
import { usePanels } from "./PanelContext";
import { SplitViewButton } from "./SplitViewButton";

/** Move a stable portal container, rather than remounting a page when a panel moves. */
function PanelPageHost({
  page,
  target,
  active,
  secondary,
  panelId,
  showSplitButton,
  isSplit,
  closePageName,
  closing,
  toggleSplit,
}: {
  page: IMainPage;
  target: HTMLElement | undefined;
  active: boolean;
  secondary: boolean;
  panelId: string | undefined;
  showSplitButton: boolean;
  isSplit: boolean;
  closePageName: string;
  closing: boolean;
  toggleSplit: (panelId: string) => void;
}) {
  const container = useMemo(() => {
    const node = document.createElement("div");
    node.className =
      "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>.main-page]:min-h-0";
    node.dataset.panelPage = page.id;
    return node;
  }, [page.id]);
  const [buttonMounted, setButtonMounted] = useState(showSplitButton);
  const [buttonShown, setButtonShown] = useState(showSplitButton);
  useEffect(() => {
    // A page opened on the right never carries the left page's split control.
    if (secondary || !panelId) {
      setButtonMounted(false);
      setButtonShown(false);
      return;
    }
    if (showSplitButton) {
      setButtonMounted(true);
      if (isReduceMotionActive()) {
        setButtonShown(true);
        return;
      }
      const frame = requestAnimationFrame(() => setButtonShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setButtonShown(false);
    if (isReduceMotionActive()) {
      setButtonMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setButtonMounted(false), 150);
    return () => window.clearTimeout(timeout);
  }, [showSplitButton, secondary, panelId]);
  useLayoutEffect(() => {
    if (target && container.parentElement !== target) target.appendChild(container);
  }, [target, container]);
  useEffect(() => () => container.remove(), [container]);
  const headerActions =
    panelId && !secondary && buttonMounted ? (
      <div
        data-responsive-split-button=""
        aria-hidden={!buttonShown}
        className={joinClasses([
          "transition-opacity duration-150",
          buttonShown ? "opacity-100" : "pointer-events-none opacity-0",
        ])}
      >
        <SplitViewButton
          disabled={closing || !showSplitButton}
          isSplit={isSplit}
          closePageName={closePageName}
          onClick={() => toggleSplit(panelId)}
        />
      </div>
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
  const { pages } = usePanels();
  const pageId = activePage(panel);
  const page = pages.find((entry) => entry.id === pageId);
  const label = page ? t(page.title, { ns: page.namespace }) : pageId || t("New panel");
  return (
    <section
      data-panel-id={panel.id}
      aria-label={t("{{page}} panel", { page: label })}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-surface-low"
    >
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

function SplitTree({
  node,
  opening,
  availableWidth,
  registerSlot,
}: {
  node: Extract<PanelNode, { kind: "split" }>;
  opening: boolean;
  availableWidth: number;
  registerSlot: (id: string, element: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const { workspace, resize, collapse, closing, completeClose } = usePanels();
  const root = useRef<HTMLDivElement>(null);
  const [dragRatio, setDragRatio] = useState<number>();
  const first = node.first.kind === "panel" ? node.first.id : undefined;
  const second = node.second.kind === "panel" ? node.second.id : undefined;
  const ratio = closing || opening ? 100 : fitSplitRatio(dragRatio ?? node.ratio, availableWidth);

  useEffect(() => {
    if (!closing) return;
    if (isReduceMotionActive()) {
      completeClose();
      return;
    }
    const fallback = window.setTimeout(completeClose, 300);
    return () => window.clearTimeout(fallback);
  }, [closing, completeClose]);

  if (!first || !second) return null;
  const pointerRatio = (clientX: number) => {
    const bounds = root.current?.getBoundingClientRect();
    return bounds
      ? Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100))
      : node.ratio;
  };
  const finishDrag = (ratioAtRelease: number) => {
    setDragRatio(undefined);
    if (ratioAtRelease <= 5) collapse(second);
    else if (ratioAtRelease >= 95) collapse(first);
    else resize(node.id, fitSplitRatio(ratioAtRelease, availableWidth));
  };
  // Animate the pane's width with the same transition used by the sidebar.
  // The first pane simply fills the remaining space, so neither page reflows
  // because its flex-grow value is changing during focus or open/close.
  const gutterWidth = opening || closing ? 0 : SPLIT_GUTTER_WIDTH;
  const secondWidth = `calc(${100 - ratio}% - ${(gutterWidth * (100 - ratio)) / 100}px)`;
  return (
    <div ref={root} data-panel-split={node.id} className="flex h-full min-h-0 min-w-0 flex-1">
      <div data-panel-split-first="" className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <PanelFrame panel={workspace.panels[first]} registerSlot={registerSlot} />
      </div>
      <button
        type="button"
        role="separator"
        aria-label={t("Resize panel columns")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio)}
        className="flex shrink-0 cursor-ew-resize touch-pan-y items-center justify-center overflow-hidden border-0 bg-surface-base text-neutral-weak transition-[width] hover:text-neutral-strong focus-visible:text-neutral-strong"
        style={{ width: gutterWidth, pointerEvents: closing ? "none" : undefined }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragRatio(pointerRatio(event.clientX));
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setDragRatio(pointerRatio(event.clientX));
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          finishDrag(pointerRatio(event.clientX));
        }}
        onPointerCancel={() => setDragRatio(undefined)}
        onDoubleClick={() => resize(node.id, 50)}
        onKeyDown={(event) => {
          if (event.key === "Home") {
            event.preventDefault();
            collapse(second);
          } else if (event.key === "End") {
            event.preventDefault();
            collapse(first);
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resize(
              node.id,
              fitSplitRatio(node.ratio + (event.key === "ArrowLeft" ? -5 : 5), availableWidth),
            );
          }
        }}
      >
        <img
          alt=""
          draggable={false}
          src="assets/panels/drag-handle.svg"
          className="pointer-events-none -rotate-90"
        />
      </button>
      <div
        data-panel-split-second=""
        className={joinClasses([
          "flex min-h-0 min-w-0 shrink-0 overflow-hidden",
          !opening && dragRatio === undefined ? "transition-[width]" : "",
        ])}
        style={{ width: secondWidth }}
        onTransitionEnd={(event) => {
          if (closing && event.target === event.currentTarget && event.propertyName === "width")
            completeClose();
        }}
      >
        <PanelFrame panel={workspace.panels[second]} registerSlot={registerSlot} />
      </div>
    </div>
  );
}

export function PanelWorkspace() {
  const { t } = useTranslation();
  const { mainPages } = usePagesContext();
  const { workspace, closing, layoutIdentity, toggleSplit, resize } = usePanels();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [canSplit, setCanSplit] = useState(false);
  const previousLayout = useRef({ identity: layoutIdentity, root: workspace.root });
  const [openingSplitId, setOpeningSplitId] = useState<string>();
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
  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setWorkspaceWidth(width);
      const fits = width >= MIN_SPLIT_PANE_WIDTH * 2 + SPLIT_GUTTER_WIDTH;
      setCanSplit(fits);
      if (!fits && workspace.root.kind === "split" && !closing)
        toggleSplit(workspace.root.first.id);
      else if (fits && workspace.root.kind === "split" && !closing) {
        const fitted = fitSplitRatio(workspace.root.ratio, width);
        if (fitted !== workspace.root.ratio) resize(workspace.root.id, fitted);
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [workspace.root, closing, toggleSplit, resize]);
  useLayoutEffect(() => {
    const previous = previousLayout.current;
    const current = workspace.root;
    previousLayout.current = { identity: layoutIdentity, root: current };
    if (
      previous.identity === layoutIdentity &&
      previous.root.kind === "panel" &&
      current.kind === "split" &&
      !isReduceMotionActive()
    ) {
      setOpeningSplitId(current.id);
      // Let the collapsed state paint before setting the target width. A
      // single frame can be batched with React's layout-effect update.
      let nextFrame = 0;
      const firstFrame = requestAnimationFrame(() => {
        nextFrame = requestAnimationFrame(() => setOpeningSplitId(undefined));
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(nextFrame);
      };
    }
    if (current.kind === "panel") setOpeningSplitId(undefined);
  }, [workspace.root, layoutIdentity]);
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
  const partnerId = workspace.root.kind === "split" ? workspace.root.second.id : undefined;
  const partnerPageId = partnerId ? workspace.panels[partnerId]?.pageId : undefined;
  const partnerPage = mainPages.find((page) => page.id === partnerPageId);
  const closePageName = partnerPage
    ? t(partnerPage.title, { ns: partnerPage.namespace })
    : partnerPageId || t("new panel");
  const hostStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    position: "relative",
    minHeight: 0,
  };
  return (
    <div
      ref={workspaceRef}
      data-panel-workspace=""
      className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1">
        <DNDContainer style={hostStyle}>
          {workspace.root.kind === "panel" ? (
            <PanelFrame panel={workspace.panels[workspace.root.id]} registerSlot={registerSlot} />
          ) : (
            <SplitTree
              node={workspace.root}
              opening={openingSplitId === workspace.root.id}
              availableWidth={workspaceWidth}
              registerSlot={registerSlot}
            />
          )}
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
              secondary={!!owner && owner.id !== ids[0]}
              panelId={owner?.id}
              showSplitButton={canSplit && owner?.id === ids[0]}
              isSplit={workspace.root.kind === "split"}
              closePageName={closePageName}
              closing={closing}
              toggleSplit={toggleSplit}
            />
          );
        })}
    </div>
  );
}
