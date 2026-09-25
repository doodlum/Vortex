import {
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

import { setPanelTabsVisible, setPanelWorkspace } from "@/actions/panels";
import { setOpenMainPage } from "@/actions/session";
import { usePagesContext } from "@/contexts";
import type { IMainPage } from "@/types/IMainPage";
import type { IState } from "@/types/IState";
import {
  addPanel,
  addTab,
  closePanel,
  closeTab,
  initialPanelWorkspace,
  isPanelWorkspace,
  MAX_TABS,
  navigatePage,
  PANEL_LAYOUT_KEY,
  resizePanel,
  selectPage,
  activePage,
  type IPanelWorkspace,
  type PanelPosition,
} from "@/util/panelLayout";
import { activeGameId, secondaryPage as selectSecondaryPage } from "@/util/selectors";

import { useSpineContext } from "../Spine/SpineContext";

export type PanelOpenMode = "current" | "panel" | "tab";
interface IPanelContext {
  workspace: IPanelWorkspace;
  pages: IMainPage[];
  navigationPages: IMainPage[];
  showTabs: boolean;
  toggleTabs: () => void;
  isHorizontal: boolean;
  setOrientation: (horizontal: boolean) => void;
  navigate: (pageId: string, mode?: PanelOpenMode) => void;
  add: (position?: PanelPosition) => void;
  newTab: (panelId?: string) => void;
  select: (panelId: string, tabId: string, pageId: string) => void;
  activate: (panelId: string, tabId: string) => void;
  close: (panelId: string, tabId?: string) => void;
  focus: (panelId: string) => void;
  resize: (id: string, ratio: number) => void;
  dismissHint: () => void;
}
const PanelContext = createContext<IPanelContext | undefined>(undefined);

export function PanelProvider({ children }: PropsWithChildren) {
  const dispatch = useDispatch();
  const { mainPages, mainPage } = usePagesContext();
  const [isHorizontal, setOrientation] = useState(true);
  const { selection, visiblePages } = useSpineContext();
  const gameId = useSelector(activeGameId);
  const secondaryPage = useSelector(selectSecondaryPage);
  const scope = selection.type === "game" ? (gameId ?? "__global") : `__${selection.type}`;
  const anchor =
    visiblePages.find((page) => page.id === mainPage)?.id ??
    visiblePages[0]?.id ??
    mainPage ??
    mainPages[0]?.id ??
    "Dashboard";
  const layouts = useSelector((state: IState) => state.settings.panels?.layouts?.[scope]);
  const showTabs = useSelector((state: IState) => state.settings.panels?.showTabs !== false);
  const saved = layouts?.[PANEL_LAYOUT_KEY];
  const legacy = useSelector((state: IState) => state.settings.splitView?.pairs?.[scope]?.[anchor]);
  const fallback = useMemo(
    () => initialPanelWorkspace(layouts, anchor, legacy),
    [layouts, anchor, legacy],
  );
  const workspace = isPanelWorkspace(saved) ? saved : fallback;
  const latest = useRef(workspace);
  latest.current = workspace;
  const sessionPage = useRef(mainPage);
  sessionPage.current = mainPage;
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
      dispatch(setPanelWorkspace(scope, PANEL_LAYOUT_KEY, next));
      const selected = activePage(next.panels[next.focusedPanel]);
      if (
        selected &&
        selected !== sessionPage.current &&
        visiblePages.some((page) => page.id === selected)
      ) {
        sessionPage.current = selected;
        dispatch(setOpenMainPage(selected, false));
      }
    },
    [scope, visiblePages, dispatch],
  );

  useEffect(() => {
    if (!isPanelWorkspace(saved)) dispatch(setPanelWorkspace(scope, PANEL_LAYOUT_KEY, fallback));
  }, [saved, scope, fallback, dispatch]);

  // External show-main-page requests navigate this game's workspace without replacing it.
  const previousSession = useRef({ scope, mainPage });
  useEffect(() => {
    const previous = previousSession.current;
    previousSession.current = { scope, mainPage };
    if (
      previous.scope !== scope ||
      previous.mainPage === mainPage ||
      !visiblePages.some((page) => page.id === mainPage)
    )
      return;
    const current = latest.current;
    if (activePage(current.panels[current.focusedPanel]) !== mainPage)
      commit(navigatePage(current, mainPage));
  }, [scope, mainPage, visiblePages, commit]);

  // Old extension Ctrl+click calls enter the new panel system through the same session action.
  useEffect(() => {
    if (secondaryPage) {
      commit(addPanel(latest.current, undefined, secondaryPage, isHorizontal));
      dispatch(setOpenMainPage("", true));
    }
  }, [secondaryPage, commit, dispatch, isHorizontal]);

  const navigate = useCallback(
    (pageId: string, mode: PanelOpenMode = "current") => {
      const current = latest.current;
      if (mode === "panel") {
        commit(addPanel(current, undefined, pageId, isHorizontal));
        return;
      }
      if (mode === "current") {
        if (activePage(current.panels[current.focusedPanel]) === pageId)
          mainPages.find((page) => page.id === pageId)?.onReset?.();
        commit(navigatePage(current, pageId));
      } else if (
        Object.values(current.panels).some((panel) =>
          panel.tabs.some((tab) => tab.pageId === pageId),
        )
      ) {
        commit(navigatePage(current, pageId));
      } else if (mode === "tab") {
        if (current.panels[current.focusedPanel].tabs.length >= MAX_TABS) return;
        const next = addTab(current);
        commit(
          selectPage(next, next.focusedPanel, next.panels[next.focusedPanel].activeTab, pageId),
        );
      }
    },
    [commit, dispatch, mainPages, isHorizontal],
  );

  const value: IPanelContext = {
    workspace,
    pages,
    navigationPages: visiblePages,
    showTabs,
    toggleTabs: () => dispatch(setPanelTabsVisible(!showTabs)),
    isHorizontal,
    setOrientation,
    navigate,
    dismissHint: () => commit({ ...latest.current, hintDismissed: true }),
    add: (position) => commit(addPanel(latest.current, position, "", isHorizontal)),
    newTab: (panelId = latest.current.focusedPanel) => commit(addTab(latest.current, panelId)),
    select: (panelId, tabId, pageId) => commit(selectPage(latest.current, panelId, tabId, pageId)),
    activate: (panelId, tabId) => {
      const current = latest.current;
      const panel = current.panels[panelId];
      if (panel && (current.focusedPanel !== panelId || panel.activeTab !== tabId))
        commit({
          ...current,
          focusedPanel: panelId,
          panels: { ...current.panels, [panelId]: { ...panel, activeTab: tabId } },
        });
    },
    focus: (panelId) => {
      if (latest.current.focusedPanel !== panelId)
        commit({ ...latest.current, focusedPanel: panelId });
    },
    close: (panelId, tabId) => {
      const next = tabId
        ? closeTab(latest.current, panelId, tabId)
        : closePanel(latest.current, panelId);
      commit(next);
    },
    resize: (id, ratio) => commit(resizePanel(latest.current, id, ratio)),
  };
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

export function usePanels() {
  const value = useContext(PanelContext);
  if (!value) throw new Error("usePanels must be used within PanelProvider");
  return value;
}
import React from "react";
