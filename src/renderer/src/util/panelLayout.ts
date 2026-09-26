/** One sidebar page, optionally paired with a second page on the right. */
export interface IPanel {
  id: string;
  pageId: string;
}
type PanelLeaf = { kind: "panel"; id: string };
export type PanelNode =
  | PanelLeaf
  | {
      kind: "split";
      id: string;
      axis: "x";
      ratio: number;
      first: PanelLeaf;
      second: PanelLeaf;
    };
export interface IPanelWorkspace {
  root: PanelNode;
  panels: Record<string, IPanel>;
  nextId: number;
}
export interface IPanelSettings {
  layouts: Record<string, Record<string, IPanelWorkspace>>;
}

export const panelIds = (node: PanelNode): string[] =>
  node.kind === "panel" ? [node.id] : [node.first.id, node.second.id];

export const activePage = (panel: IPanel) => panel.pageId;

export function createWorkspace(pageId: string): IPanelWorkspace {
  return {
    root: { kind: "panel", id: "panel-1" },
    panels: { "panel-1": { id: "panel-1", pageId } },
    nextId: 2,
  };
}

export function initialPanelWorkspace(
  layouts: Record<string, IPanelWorkspace> | undefined,
  pageId: string,
): IPanelWorkspace {
  const saved = layouts?.[pageId];
  return isPanelWorkspace(saved)
    ? normalizeSidebarWorkspace(saved, pageId)
    : createWorkspace(pageId);
}

/** The selected sidebar page always owns the left pane. */
export function normalizeSidebarWorkspace(workspace: IPanelWorkspace, pageId: string) {
  return workspace.panels[panelIds(workspace.root)[0]]?.pageId === pageId
    ? workspace
    : createWorkspace(pageId);
}

/** Opening always starts with a blank partner. */
export function openSplitView(workspace: IPanelWorkspace): IPanelWorkspace {
  if (workspace.root.kind !== "panel") return workspace;
  const id = `panel-${workspace.nextId}`;
  return {
    ...workspace,
    root: {
      kind: "split",
      id: `split-${id}`,
      axis: "x",
      ratio: 50,
      first: workspace.root,
      second: { kind: "panel", id },
    },
    panels: { ...workspace.panels, [id]: { id, pageId: "" } },
    nextId: workspace.nextId + 1,
  };
}

/** Closing forgets the partner instead of keeping a hidden page. */
export function collapseToPanel(workspace: IPanelWorkspace, id: string): IPanelWorkspace {
  if (workspace.root.kind !== "split" || !panelIds(workspace.root).includes(id)) return workspace;
  return {
    ...workspace,
    root: { kind: "panel", id },
    panels: { [id]: workspace.panels[id] },
  };
}

export function selectPage(
  workspace: IPanelWorkspace,
  panelId: string,
  pageId: string,
): IPanelWorkspace {
  const panel = workspace.panels[panelId];
  if (
    !panel ||
    Object.values(workspace.panels).some((other) => other.id !== panelId && other.pageId === pageId)
  )
    return workspace;
  return {
    ...workspace,
    panels: { ...workspace.panels, [panelId]: { ...panel, pageId } },
  };
}

export function resizePanel(
  workspace: IPanelWorkspace,
  id: string,
  ratio: number,
): IPanelWorkspace {
  if (!Number.isFinite(ratio) || workspace.root.kind !== "split" || workspace.root.id !== id)
    return workspace;
  return {
    ...workspace,
    root: { ...workspace.root, ratio: Math.max(20, Math.min(80, ratio)) },
  };
}

/** Reject damaged saved layouts before using their panel IDs in the renderer. */
export function isPanelWorkspace(value: unknown): value is IPanelWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as IPanelWorkspace;
  if (
    !workspace.panels ||
    !Number.isSafeInteger(workspace.nextId) ||
    workspace.nextId < 2 ||
    !workspace.root ||
    typeof workspace.root.id !== "string"
  )
    return false;
  const root = workspace.root;
  if (
    root.kind !== "panel" &&
    (root.kind !== "split" ||
      root.axis !== "x" ||
      !Number.isFinite(root.ratio) ||
      root.ratio < 20 ||
      root.ratio > 80 ||
      root.first?.kind !== "panel" ||
      root.second?.kind !== "panel" ||
      typeof root.first.id !== "string" ||
      typeof root.second.id !== "string" ||
      root.first.id === root.second.id)
  )
    return false;
  const ids = panelIds(root);
  if (Object.keys(workspace.panels).length !== ids.length) return false;
  const pages = new Set<string>();
  return ids.every((id) => {
    const panel = workspace.panels[id];
    if (
      panel?.id !== id ||
      typeof panel.pageId !== "string" ||
      (panel.pageId && pages.has(panel.pageId))
    )
      return false;
    if (panel.pageId) pages.add(panel.pageId);
    return true;
  });
}
