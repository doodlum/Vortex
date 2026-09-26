# Split view

The modern layout supports one page or two side-by-side pages. Each sidebar
page has its own saved workspace within its game; Home pages use a separate
scope. Sidebar navigation keeps its stock selection and appearance. Selecting
another sidebar page loads that page's own workspace, without activating or
changing either pane in the previous page's workspace. There are no panel tabs,
pop-out windows, or title-bar panel controls.

## Opening and closing

The sidebar page's modern header has a 28px outlined **Dock right** button in
its top-right corner. It is a toggle: its icon stays the same, `aria-pressed`
and a highlighted background/border show when split view is open, and its
tooltip changes between **Enter split view** and **Close {page name}**. An empty
right pane uses **Close new panel**. The opened right-hand page never has a
split button of its own. Older pages have no temporary header.

Opening adds an empty pane on the right. Its headerless chooser centers the
same navigation rows used by the sidebar and lists only pages available in the
current Home or game context that are not already open. Closing forgets the
other pane; opening again starts with a blank chooser. The pane grows and
shrinks with the sidebar's width transition (150ms at the default motion
setting). Reduced motion completes immediately.

The split needs room for two 440px panes and its divider. Below that content
width, the right pane animates closed and its saved pairing is cleared. The Dock
right toggle fades out, then leaves the header; it fades back in when the window
is wide enough again.

The 12px divider resizes the two columns. Dragging it to the right edge closes
the partner; dragging to the left edge navigates to the partner's sidebar page
and loads that page's own workspace. Intermediate positions keep each pane at
least 440px wide, including when a saved split opens in a narrower window.
Arrow keys adjust its ratio; Home/End
collapse a side, and double click restores 50/50.

## Navigation and state

Each game's sidebar page saves its partner and divider ratio under its own key,
so returning to it or restarting Vortex restores the split. Other sidebar
pages keep independent layouts. Extension main pages are singletons, so stable
portal containers retain their state as the layout changes. Unavailable
extension pages show a placeholder without erasing the saved workspace.

## Verification

Renderer unit tests cover per-sidebar persistence, split/reset behavior, the
chooser, and the toggle. The automation kit's `ai:test:panels` runs against a
Bethesda sandbox in a real Vortex and checks animation, chooser scope, close
labels, per-sidebar persistence, the absence of a right-pane toggle, resizing
including automatic close at narrow widths, edge collapse, and Home navigation.
It restores the original workspaces and window size afterward.
