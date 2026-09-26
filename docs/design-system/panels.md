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
  current divider ratios and the proposed panel bounds. The two-part control
  scales with the profile button: 28px high in Vortex's 44px title bar, with
  a 28px primary segment and an 18px dropdown segment.
- The adjacent profile control is also 46×28px, with a circular avatar and
  dropdown chevron inside one outlined button. The title-bar order is Panels,
  Profile, Premium status, divider, Version, divider, then window controls.
  When signed out, the Help menu occupies the profile slot; when no Premium
  status is shown, its divider disappears with it.
- Up to four panels form columns, rows, or a two-by-two layout. A pending
  unfilled panel moves when another position is chosen, rather than creating
  a second empty panel. A fourth panel aligns its new divider with its neighbor.
- The new panel chooser uses the sidebar surface and shared NavigationButton
  rows. It lists only pages from the current Home or game sidebar that are not
  already open. It has one close control and no search or separate tabs.
- A sidebar page that is already open focuses its panel. An unopened page
  replaces the page in the active panel. Ctrl+click or the sidebar context menu
  opens the page in a new panel. Open pages have the sidebar selection
  background; only the focused panel's page has the 2px neutral-600 outline.
- Modern pages pin the panel close button to the header's top-right corner,
  including when their toolbar wraps or the header expands. Headers do not add
  a separator beside it. Every panel X uses the shared 28px neutral subdued
  button with a 1px outline and transparent resting background. A wrapped
  toolbar reaches the normal right content margin without a reserved close-button
  gap. Older pages and the empty chooser use a temporary header matching the
  compact modern header: 28px pale-to-lavender gradient icon, 18px subdued
  semibold title, 12px vertical padding, and matching close-button spacing.
  Legacy page toolbars stay visible below it in every open panel, even when
  another panel has focus. A single panel has no close control. Legacy Sass surface
  shades track the modern low, mid, and high tokens, while the broad legacy
  page body uses surface-low and its toolbar uses surface-mid until those pages
  are migrated.
- Clicking anywhere inside a panel focuses it. The edge overlays a fixed 2px
  inset so focus changes never resize or shift the page. The focused edge is
  2px Figma neutral-600 (#52525b), including when it is the only panel; the
  unfocused edge is 1px surface-low, matching the Mods background. Drag a 12px
  gutter to resize; arrow keys, Home/End, and double click also adjust or reset
  a divider.

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
