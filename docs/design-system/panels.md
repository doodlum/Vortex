# Panels

The modern layout uses panels in place of the previous split view. The source is
[Panel management in Figma](https://www.figma.com/design/VNqTTMrBsVaU2UZ9UlNsJj/Panel-management?node-id=106-36450).
The whole canvas informs this implementation. The design owner selected the
visible placement dropdown and explicitly requested that every panel retain its
tab bar. Later experiments that hide single-tab bars do not apply. The design
owner subsequently replaced the chooser card with sidebar rows and removed
pop-out windows. Experimental linking is excluded by the design owner's choice.

## Interaction

- The application title bar's panel button creates a page chooser at the next
  position. A wide single-panel workspace starts with a right column; a tall one
  starts with a bottom row. Subsequent choices depend on the grid shape. The adjacent dropdown
  chooses another legal position; right click and Shift+F10 also open that menu.
  The button and menu draw their icons from the current split ratios and proposed
  panel bounds, so dragging a divider changes the icon. A fourth panel aligns
  its new divider with the neighboring one. This follows the state-driven
  candidate and icon approach in [Nexus Mods App's GridUtils](https://github.com/Nexus-Mods/NexusMods.App/blob/main/src/NexusMods.App.UI/WorkspaceSystem/GridUtils.cs)
  and [IconUtils](https://github.com/Nexus-Mods/NexusMods.App/blob/main/src/NexusMods.App.UI/WorkspaceSystem/IconUtils.cs).
- Up to four panels form columns, rows, or a two-by-two layout. A new panel takes
  half its available space. Full columns are added on the right, full rows below.
  Only one unfilled new panel exists at a time; another position moves it.
- Right click a sidebar page to open it in a panel or in a tab. Ctrl+click opens
  a panel; Shift+click opens a tab. Plain navigation activates that page's
  existing tab in place. If it is not open, navigation replaces the active tab
  in the active panel, regardless of its size.
- Each panel's always-visible tab bar holds its new-tab and close actions
  on the right. There is no new-tab action in the application title bar. Panels
  allow up to 16 tabs. Arrow keys, Home, End and Delete operate tabs; overflow
  arrows scroll by 232px. A single tab has no redundant tab-close button.
  Tab bars use the sidebar's 40px height, 16px icons, semibold `body-sm`
  labels, and 12px icon-to-label spacing. Their dark surface is the sampled
  `#141417`; tabs are flush, rectangular, and separated by a thin stroke.
- The panel-position dropdown also switches between tab bars and a tab-free
  variant. This global preference persists across restarts without deleting
  saved tabs. In the tab-free variant, the sidebar switches pages and the
  page's new header places the panel close action after its toolbar, with a
  vertical divider. Older pages and the New tab chooser use a small fallback
  action row. The sidebar's explicit new-tab action is hidden in this mode.
- Opening a tab or a panel presents the same “New tab” page and tab title. Its
  chooser uses the sidebar's surface and shared NavigationButton rows in sidebar
  order. It lists only the current sidebar's pages that are not already open in another tab or panel,
  without search, section headings, or a split-view card. A new panel has one
  close control in its tab bar.
- Drag anywhere in a 12px gutter to resize. Arrow keys also resize a focused
  divider; Home/End choose its limits, and double click resets it to half.
- Only the focused page is selected in the sidebar, with an outline when several
  panels are present. The panel frame retains a visible weak
  border even when it is the only panel. The old paired row and split opener are gone.
- Panels stay within the main application window. Clicking anywhere in a panel,
  or moving keyboard focus into its content, selects and highlights that panel.

## Vortex adaptations

Extension main pages are singletons: they use shared DOM IDs, event subscriptions
and store paths. Selecting an already-open page focuses that instance instead of
mounting a duplicate. Stable portal containers retain the page when panels move.

Settings persist one active layout per game and a separate Home layout, including
tabs, focus, and divider ratios. The first use migrates the layout saved for the current sidebar page (or
an earlier split pairing), then sidebar navigation never changes the layout.
When entering Home or a game without a saved layout, the first panel starts on a page
available in that sidebar, even if the previous context's page is still selected
while navigation settles.
The legacy reducer remains only to read that migration input.
Unavailable extension pages display a placeholder without erasing their saved tabs.

Below 720px of content width or 360px of content height, a panel switcher shows one
panel at a time without modifying the saved arrangement. Page chooser options and
icons come from Vortex's registered pages; prototype collections are not hardcoded.
The existing 44px Vortex title bar and shared Button and profile-menu
components supply app styling. Panel, tab and divider SVGs are local Figma exports
in `assets/panels/`. Tab icons render at the sidebar's 16px size; other exported
controls retain their intrinsic dimensions.

## Design references

| Nodes                | Behavior                                          |
| -------------------- | ------------------------------------------------- |
| 106:36451, 215:56279 | Creating, closing, switching and overflowing tabs |
| 106:43434, 327:6108  | Panel creation, placements and closing            |
| 106:38227, 126:4931  | Panel creation and always-visible panel controls  |
| 106:37831, 866:8980  | Shared new-tab page and sidebar navigation rows   |
| 209:43785            | Right-side placement button and visible dropdown  |
| 443:6109, 443:7927   | 12px gutters and drag handles                     |
| 937:10027, 937:9508  | Selected panels, tabs and sidebar pages           |

## Verification

`pnpm run verify` covers formatting, build, typecheck, lint and unit tests. The
placement tests exhaust all legal four-panel layouts and close each leaf.
The automation kit's `ai:test:panels` exercises real Vortex. Run its
`--verify-saved` mode after a clean down/up of the same Bethesda sandbox to check
disk persistence independently. Neither command claims the packaged E2E suite.
