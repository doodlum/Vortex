import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useDispatch, useSelector } from "react-redux";

import { setPanelWorkspace } from "@/actions/panels";
import { setOpenMainPage } from "@/actions/session";
import { usePagesContext } from "@/contexts";
import type { IMainPage } from "@/types/IMainPage";
import type { IState } from "@/types/IState";
import {
  collapseToPanel,
  initialPanelWorkspace,
  openSplitView,
  resizePanel,
  selectPage,
  type IPanelWorkspace,
} from "@/util/panelLayout";
import { activeGameId } from "@/util/selectors";

import { useSpineContext } from "../Spine/SpineContext";

interface IPanelContext {
  workspace: IPanelWorkspace;
  pages: IMainPage[];
  navigationPages: IMainPage[];
  closing: boolean;
  layoutIdentity: string;
  toggleSplit: (panelId: string) => void;
  completeClose: () => void;
  collapse: (panelId: string) => void;
  select: (panelId: string, pageId: string) => void;
  resize: (id: string, ratio: number) => void;
}
const PanelContext = createContext<IPanelContext | undefined>(undefined);

export function PanelProvider({ children }: PropsWithChildren) {
  const dispatch = useDispatch();
  const { mainPages, mainPage } = usePagesContext();
  const { selection, visiblePages } = useSpineContext();
  const gameId = useSelector(activeGameId);
  const scope = selection.type === "game" ? (gameId ?? "__global") : `__${selection.type}`;
  const anchor =
    visiblePages.find((page) => page.id === mainPage)?.id ??
    visiblePages[0]?.id ??
    mainPage ??
    mainPages[0]?.id ??
    "Dashboard";
  const layoutIdentity = `${scope}:${anchor}`;
  const layouts = useSelector((state: IState) => state.settings.panels?.layouts?.[scope]);
  const saved = layouts?.[anchor];
  const legacyTabPreference = useSelector(
    (state: IState) => state.settings.panels !== undefined && "showTabs" in state.settings.panels,
  );
  const workspace = useMemo(() => initialPanelWorkspace(layouts, anchor), [layouts, anchor]);
  const latest = useRef(workspace);
  latest.current = workspace;
  const [closingIdentity, setClosingIdentity] = useState<string>();
  const closing = closingIdentity === layoutIdentity;

  const availableIds = useSelector(() =>
    mainPages
      .filter((page) => {
        try {
          return page.group !== "hidden" && page.id !== "game-downloads" && page.visible();
        } catch {
          return false;
        }
      })
      .map((page) => page.id)
      .join("\n"),
  );
  const pages = useMemo(
    () => mainPages.filter((page) => availableIds.split("\n").includes(page.id)),
    [mainPages, availableIds],
  );
  const commit = useCallback(
    (next: IPanelWorkspace) => {
      if (next === latest.current) return;
      latest.current = next;
      dispatch(setPanelWorkspace(scope, anchor, next));
    },
    [scope, anchor, dispatch],
  );

  useEffect(() => {
    if ((saved !== undefined && saved !== workspace) || legacyTabPreference)
      dispatch(setPanelWorkspace(scope, anchor, workspace));
  }, [saved, scope, anchor, workspace, legacyTabPreference, dispatch]);
  useEffect(() => setClosingIdentity(undefined), [layoutIdentity]);

  const value: IPanelContext = {
    workspace,
    pages,
    navigationPages: visiblePages,
    closing,
    layoutIdentity,
    toggleSplit: (panelId) => {
      if (closing || !latest.current.panels[panelId]) return;
      if (latest.current.root.kind === "panel") commit(openSplitView(latest.current));
      else setClosingIdentity(layoutIdentity);
    },
    completeClose: () => {
      const current = latest.current;
      if (closing && current.root.kind === "split" && current.root.first.kind === "panel")
        commit(collapseToPanel(current, current.root.first.id));
      setClosingIdentity(undefined);
    },
    collapse: (panelId) => {
      setClosingIdentity(undefined);
      const current = latest.current;
      if (current.root.kind !== "split" || current.root.first.kind !== "panel") return;
      const firstId = current.root.first.id;
      const otherPage = current.panels[panelId]?.pageId;
      commit(collapseToPanel(current, firstId));
      // Collapsing the sidebar page at the left edge makes the remaining page
      // the stock sidebar selection, with that page's own saved split layout.
      if (panelId !== firstId && otherPage && visiblePages.some((page) => page.id === otherPage))
        dispatch(setOpenMainPage(otherPage, false));
    },
    select: (panelId, pageId) => commit(selectPage(latest.current, panelId, pageId)),
    resize: (id, ratio) => commit(resizePanel(latest.current, id, ratio)),
  };
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanels() {
  const value = useContext(PanelContext);
  if (!value) throw new Error("usePanels must be used within PanelProvider");
  return value;
}
