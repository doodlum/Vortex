# Panels

The modern layout replaces the earlier split view. Its placement controls and
geometry are based on [Panel management in Figma](https://www.figma.com/design/VNqTTMrBsVaU2UZ9UlNsJj/Panel-management?node-id=106-36450)
and [Nexus Mods App's GridUtils](https://github.com/Nexus-Mods/NexusMods.App/blob/main/src/NexusMods.App.UI/WorkspaceSystem/GridUtils.cs).
Experimental linking and pop-out windows are excluded. Panels have no tab bar:
each panel holds one page, and the sidebar is the page switcher.

## Interaction

- The title-bar panel button opens a new panel's page chooser. A wide
  single-panel workspace adds a right column; a tall one adds a bottom row.
  The adjacent dropdown offers every legal position. Right click or Shift+F10
  on the button opens that dropdown too. The button and menu icons reflect
  current divider ratios and the proposed panel bounds.
- Up to four panels form columns, rows, or a two-by-two layout. A pending
  unfilled panel moves when another position is chosen, rather than creating
  a second empty panel. A fourth panel aligns its new divider with its neighbor.
- The new panel chooser uses the sidebar surface and shared NavigationButton
  rows. It lists only pages from the current Home or game sidebar that are not
  already open. It has one close control and no search or separate tabs.
- A sidebar page that is already open focuses its panel. An unopened page
  replaces the page in the active panel. Ctrl+click or the sidebar context menu
  opens the page in a new panel. Open pages have the sidebar selection
  background; only the focused panel's page has the outline.
- Modern pages place the panel close control after the page toolbar. Older
  pages and the empty chooser use a small action row with page icon and title.
  The row uses the page background color. A single panel has no close control.
- Clicking anywhere inside a panel focuses it. Its border remains visible when
  there is only one panel. Drag a 12px gutter to resize; arrow keys, Home/End,
  and double click also adjust or reset a divider.

## State and responsive behavior

Extension main pages are singletons because they share DOM IDs, event
subscriptions and state. Stable portal containers retain each page when
panels move. Each game has one saved layout, and Home has a separate one.
Saved geometry, focus and each panel's visible page persist across restarts.
On first load after the tabbed version, the selected tab in each panel becomes
that panel's page; inactive tabs are discarded. Earlier page-specific layouts
and split pairings still migrate on first use.

Unavailable extension pages show a placeholder without erasing their saved
panel. Below 720px of content width or 360px of height, a panel switcher
shows one panel at a time without modifying the saved arrangement.

## Verification

`pnpm run verify` covers formatting, build, typecheck, lint and unit tests.
The automation kit's `ai:test:panels` exercises panel navigation and
placement in a real Vortex. Its `--verify-saved` mode checks disk
persistence after a clean down/up of the same Bethesda sandbox.
