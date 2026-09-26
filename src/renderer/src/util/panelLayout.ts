/** Persisted panel layout. Each panel owns one singleton extension page. */
export interface IPanel {
  id: string;
  placement?: PanelPosition;
  pageId: string;
}
export type PanelNode =
  | { kind: "panel"; id: string }
  | {
      kind: "split";
      id: string;
      axis: "x" | "y";
      ratio: number;
      first: PanelNode;
      second: PanelNode;
    };
export interface IPanelWorkspace {
  hintDismissed?: boolean;
  root: PanelNode;
  panels: Record<string, IPanel>;
  focusedPanel: string;
  nextId: number;
  recent: string[];
}
export interface IPanelSettings {
  layouts: Record<string, Record<string, IPanelWorkspace>>;
}
export type PanelPosition =
  | "right"
  | "left"
  | "bottom"
  | "top"
  | "top-right"
  | "bottom-right"
  | "bottom-left"
  | "top-left";
export interface IPanelPlacement {
  position: PanelPosition;
  target: string;
  axis: "x" | "y";
  before: boolean;
}
export interface IPanelBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export const MAX_PANELS = 4;
export const PANEL_LAYOUT_KEY = "__workspace";

export const panelIds = (node: PanelNode): string[] =>
  node.kind === "panel" ? [node.id] : [...panelIds(node.first), ...panelIds(node.second)];

export function createWorkspace(pageId: string, partner?: string): IPanelWorkspace {
  const initial: IPanelWorkspace = {
    root: { kind: "panel", id: "panel-1" },
    panels: { "panel-1": { id: "panel-1", pageId } },
    focusedPanel: "panel-1",
    nextId: 2,
    recent: pageId ? [pageId] : [],
  };
  return partner && partner !== pageId ? addPanel(initial, "right", partner) : initial;
}

/** Retain each panel's visible page and geometry when upgrading a tabbed layout. */
export function migratePanelWorkspace(value: unknown): IPanelWorkspace | undefined {
  if (isPanelWorkspace(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const legacy = value as IPanelWorkspace & {
    panels: Record<
      string,
      IPanel & { tabs?: { id: string; pageId: string }[]; activeTab?: string }
    >;
  };
  if (!legacy.panels || typeof legacy.panels !== "object") return undefined;
  const panels: Record<string, IPanel> = {};
  for (const [id, panel] of Object.entries(legacy.panels)) {
    if (!panel || !Array.isArray(panel.tabs) || typeof panel.activeTab !== "string")
      return undefined;
    const activeTab = panel.tabs.find((tab) => tab?.id === panel.activeTab);
    if (!activeTab || typeof activeTab.pageId !== "string") return undefined;
    panels[id] = { id: panel.id, placement: panel.placement, pageId: activeTab.pageId };
  }
  const migrated = { ...legacy, panels };
  return isPanelWorkspace(migrated) ? migrated : undefined;
}

/** Move from page-specific layouts once, then keep one workspace for this game or context. */
export function initialPanelWorkspace(
  layouts: Record<string, IPanelWorkspace> | undefined,
  pageId: string,
  partner?: string,
): IPanelWorkspace {
  const shared = layouts?.[PANEL_LAYOUT_KEY];
  const migratedShared = migratePanelWorkspace(shared);
  if (migratedShared) return migratedShared;
  const previous = layouts?.[pageId];
  const migratedPrevious = migratePanelWorkspace(previous);
  if (migratedPrevious) return migratedPrevious;
  return (
    Object.values(layouts ?? {})
      .map(migratePanelWorkspace)
      .find((workspace) => workspace !== undefined) ?? createWorkspace(pageId, partner)
  );
}

export function replaceNode(root: PanelNode, id: string, replacement: PanelNode): PanelNode {
  if (root.id === id) return replacement;
  if (root.kind === "panel") return root;
  return {
    ...root,
    first: replaceNode(root.first, id, replacement),
    second: replaceNode(root.second, id, replacement),
  };
}

export function removeNode(root: PanelNode, id: string): PanelNode | undefined {
  if (root.id === id) return undefined;
  if (root.kind === "panel") return root;
  const first = removeNode(root.first, id);
  const second = removeNode(root.second, id);
  return first && second ? { ...root, first, second } : (first ?? second);
}

/** Legal positions from the design's two-by-two placement diagrams, independent of resize ratios. */
export function panelPlacements(root: PanelNode): IPanelPlacement[] {
  const count = panelIds(root).length;
  if (count >= MAX_PANELS) return [];
  const result: IPanelPlacement[] = [];
  if (root.kind === "panel" || (root.axis === "y" && count === 2)) {
    result.push({ position: "right", target: root.id, axis: "x", before: false });
    result.push({ position: "left", target: root.id, axis: "x", before: true });
  }
  if (root.kind === "panel" || (root.axis === "x" && count === 2)) {
    result.push({ position: "bottom", target: root.id, axis: "y", before: false });
    result.push({ position: "top", target: root.id, axis: "y", before: true });
  }
  if (root.kind === "panel") return result;
  const visit = (node: PanelNode, x: number, y: number, w: number, h: number) => {
    if (node.kind === "split") {
      visit(node.first, x, y, node.axis === "x" ? w / 2 : w, node.axis === "y" ? h / 2 : h);
      visit(
        node.second,
        x + (node.axis === "x" ? w / 2 : 0),
        y + (node.axis === "y" ? h / 2 : 0),
        node.axis === "x" ? w / 2 : w,
        node.axis === "y" ? h / 2 : h,
      );
    } else if (h === 2) {
      result.push({
        position: x === 0 ? "top-left" : "top-right",
        target: node.id,
        axis: "y",
        before: true,
      });
      result.push({
        position: x === 0 ? "bottom-left" : "bottom-right",
        target: node.id,
        axis: "y",
        before: false,
      });
    } else if (w === 2) {
      result.push({
        position: y === 0 ? "top-left" : "bottom-left",
        target: node.id,
        axis: "x",
        before: true,
      });
      result.push({
        position: y === 0 ? "top-right" : "bottom-right",
        target: node.id,
        axis: "x",
        before: false,
      });
    }
  };
  visit(root, 0, 0, 2, 2);
  return result;
}

/** Nexus-style ordering based on workspace orientation and the current grid shape. */
export function defaultPlacement(root: PanelNode, isHorizontal = true): PanelPosition | undefined {
  const available = panelPlacements(root);
  const count = panelIds(root).length;
  const order: PanelPosition[] =
    count === 1
      ? isHorizontal
        ? ["right", "bottom", "left", "top"]
        : ["bottom", "right", "top", "left"]
      : count === 2 && root.kind === "split" && root.axis === "x"
        ? isHorizontal
          ? ["bottom-right", "top-right", "bottom-left", "top-left", "bottom", "top"]
          : ["bottom", "top", "bottom-right", "top-right", "bottom-left", "top-left"]
        : count === 2
          ? isHorizontal
            ? ["top-right", "top-left", "bottom-right", "bottom-left", "right", "left"]
            : ["bottom-right", "bottom-left", "top-right", "top-left", "right", "left"]
          : ["bottom-right", "bottom-left", "top-right", "top-left"];
  return order.find((position) => available.some((item) => item.position === position));
}

/** Normalized rectangles preserve the real divider ratios for icons and placement. */
export function panelBounds(root: PanelNode): IPanelBounds[] {
  const result: IPanelBounds[] = [];
  const visit = (node: PanelNode, x: number, y: number, width: number, height: number) => {
    if (node.kind === "panel") {
      result.push({ id: node.id, x, y, width, height });
      return;
    }
    const first = node.ratio / 100;
    if (node.axis === "x") {
      visit(node.first, x, y, width * first, height);
      visit(node.second, x + width * first, y, width * (1 - first), height);
    } else {
      visit(node.first, x, y, width, height * first);
      visit(node.second, x, y + height * first, width, height * (1 - first));
    }
  };
  visit(root, 0, 0, 1, 1);
  return result;
}

/** Split a candidate, matching the neighboring divider when completing a 2×2 grid. */
export function previewPanelPlacement(
  root: PanelNode,
  placement: IPanelPlacement,
  newPanelId = "__new-panel",
): PanelNode {
  const find = (node: PanelNode): PanelNode | undefined =>
    node.id === placement.target
      ? node
      : node.kind === "split"
        ? (find(node.first) ?? find(node.second))
        : undefined;
  const target = find(root);
  if (!target) return root;
  const sibling =
    root.kind === "split" && root.first.id === target.id
      ? root.second
      : root.kind === "split" && root.second.id === target.id
        ? root.first
        : undefined;
  const ratio = sibling?.kind === "split" && sibling.axis === placement.axis ? sibling.ratio : 50;
  const leaf: PanelNode = { kind: "panel", id: newPanelId };
  const split: PanelNode = {
    kind: "split",
    id: `split-${newPanelId}`,
    axis: placement.axis,
    ratio,
    first: placement.before ? leaf : target,
    second: placement.before ? target : leaf,
  };
  return replaceNode(root, target.id, split);
}

export const activePage = (panel: IPanel) => panel.pageId;

export function closePanel(workspace: IPanelWorkspace, id: string): IPanelWorkspace {
  const root = removeNode(workspace.root, id);
  if (!root) return workspace;
  const panels = { ...workspace.panels };
  delete panels[id];
  return {
    ...workspace,
    root,
    panels,
    focusedPanel: panels[workspace.focusedPanel] ? workspace.focusedPanel : panelIds(root)[0],
  };
}

export function addPanel(
  workspace: IPanelWorkspace,
  position?: PanelPosition,
  pageId = "",
  isHorizontal = true,
): IPanelWorkspace {
  const existing =
    pageId && Object.values(workspace.panels).find((panel) => panel.pageId === pageId);
  if (existing) return selectPage(workspace, existing.id, pageId);
  const pending = Object.values(workspace.panels).find((panel) => !panel.pageId);
  const base = pending ? closePanel(workspace, pending.id) : workspace;
  const choice = panelPlacements(base.root).find(
    (item) => item.position === (position ?? defaultPlacement(base.root, isHorizontal)),
  );
  if (!choice) return workspace;
  const id = `panel-${base.nextId}`;
  return {
    ...base,
    root: previewPanelPlacement(base.root, choice, id),
    nextId: base.nextId + 1,
    focusedPanel: id,
    panels: {
      ...base.panels,
      [id]: { id, placement: choice.position, pageId },
    },
    recent: pageId
      ? [pageId, ...base.recent.filter((item) => item !== pageId)].slice(0, 8)
      : base.recent,
  };
}

export function selectPage(
  workspace: IPanelWorkspace,
  panelId: string,
  pageId: string,
): IPanelWorkspace {
  const existing = Object.values(workspace.panels).find(
    (panel) => panel.pageId === pageId && !!pageId,
  );
  if (existing) {
    // Choosing an already-open extension page focuses its single instance and cancels the blank chooser.
    const base =
      workspace.panels[panelId] && !workspace.panels[panelId].pageId && panelId !== existing.id
        ? closePanel(workspace, panelId)
        : workspace;
    return { ...base, focusedPanel: existing.id };
  }
  const panel = workspace.panels[panelId];
  if (!panel) return workspace;
  return {
    ...workspace,
    focusedPanel: panelId,
    recent: pageId
      ? [pageId, ...workspace.recent.filter((item) => item !== pageId)].slice(0, 8)
      : workspace.recent,
    panels: {
      ...workspace.panels,
      [panelId]: {
        ...panel,
        pageId,
      },
    },
  };
}

/** Sidebar navigation focuses an open page or replaces the focused panel's page. */
export function navigatePage(workspace: IPanelWorkspace, pageId: string): IPanelWorkspace {
  if (!pageId) return workspace;
  for (const panelId of panelIds(workspace.root)) {
    if (workspace.panels[panelId].pageId === pageId) return selectPage(workspace, panelId, pageId);
  }
  const panelId = workspace.focusedPanel;
  return selectPage(workspace, panelId, pageId);
}

export function resizePanel(
  workspace: IPanelWorkspace,
  id: string,
  ratio: number,
): IPanelWorkspace {
  const resize = (node: PanelNode): PanelNode =>
    node.kind === "panel"
      ? node
      : {
          ...node,
          ratio: node.id === id ? Math.max(20, Math.min(80, ratio)) : node.ratio,
          first: resize(node.first),
          second: resize(node.second),
        };
  return Number.isFinite(ratio) ? { ...workspace, root: resize(workspace.root) } : workspace;
}

/** Validate persisted trees before rendering: bounded depth, references and unique pages. */
export function isPanelWorkspace(value: unknown): value is IPanelWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as IPanelWorkspace;
  if (
    !workspace.panels ||
    !Number.isSafeInteger(workspace.nextId) ||
    workspace.nextId < 2 ||
    !Array.isArray(workspace.recent) ||
    !workspace.recent.every((id) => typeof id === "string")
  )
    return false;
  const nodes = new Set<string>();
  const leaves: string[] = [];
  const validNode = (node: PanelNode, depth: number): boolean => {
    if (!node || depth > 3 || typeof node.id !== "string" || nodes.has(node.id)) return false;
    nodes.add(node.id);
    if (node.kind === "panel") {
      leaves.push(node.id);
      return true;
    }
    return (
      node.kind === "split" &&
      ["x", "y"].includes(node.axis) &&
      Number.isFinite(node.ratio) &&
      node.ratio >= 20 &&
      node.ratio <= 80 &&
      validNode(node.first, depth + 1) &&
      validNode(node.second, depth + 1)
    );
  };
  if (
    !validNode(workspace.root, 0) ||
    leaves.length > MAX_PANELS ||
    !leaves.includes(workspace.focusedPanel) ||
    Object.keys(workspace.panels).length !== leaves.length
  )
    return false;
  const pages = new Set<string>();
  return leaves.every((id) => {
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
