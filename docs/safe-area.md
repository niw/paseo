# Safe area

Backgrounds and read-only content run edge to edge: chat text, the terminal grid, a diff and file
text can sit under a side inset. Controls stay inside the safe-area insets on all four sides:
buttons, inputs, pickers, list rows you tap, and the keys of the terminal key bar. Rules, like
borders and separators, are part of the background and reach the edge too.

Don't assume an inset's edge. On iPhone Duo the camera and status bar sit in an 84pt strip on the
left or right, with a top inset of 0, in both the folded portrait (compact) and unfolded landscape
(wide) postures. Only the unfolded portrait posture has a top status bar. The bottom inset stays
34pt in landscape.

## Insets flow down and are consumed once

`useSafeAreaInsets()` returns the insets still left for the view that reads it: those of the window
edges its region touches, minus what an ancestor already padded. Two things narrow it:

- A region narrows it to the window edges it touches. `HorizontalSafeAreaRegion`
  (`packages/app/src/components/safe-area-edges.tsx`) passes 0 for an edge the region does not
  touch.
- A surface that pads its content by the side insets consumes them: `PaddedSideInsetsView` and
  `ConsumeSideInsets` pass 0 on, so nothing pads them twice.

| Region                  | Declared in                                           | Edges                                   |
| ----------------------- | ----------------------------------------------------- | --------------------------------------- |
| App sidebar (wide)      | `app/_layout.tsx`                                     | left                                    |
| App content             | `app/_layout.tsx`                                     | right, plus left when no sidebar shows  |
| Workspace column (wide) | `screens/workspace/workspace-screen.tsx`              | left, plus right when no explorer docks |
| Explorer panel          | `screens/workspace/explorer-sidebar/frame.tsx`        | right, or both as an overlay            |
| Changes tree rail       | `components/tree-rail.tsx`                            | the diff left, the rail right           |
| Settings sidebar/detail | `screens/settings-screen.tsx`                         | left / right                            |
| Sheet content           | `components/ui/isolated-bottom-sheet-modal/index.tsx` | none: the sheet pads both itself        |

The bottom inset is consumed the same way: `SheetBottomInset` passes none on (see
[floating-panels.md](floating-panels.md#gotcha-8--read-safe-area-insets-where-the-overlay-draws)).

A sidebar or explorer that takes an inset grows by it, so its rows keep their width.

## Panes handle their own insets

A pane renders in the workspace column, the explorer or a sheet, and it lays out the same in each.
The hosts never pad a pane; each is a region, and a sheet hosts a pane in `SheetFullBleedRegion`.

A pane kind declares `ownsSideInsets` in `packages/app/src/panels/panel-manifest.ts`. When it is
true the pane runs its content under the side insets and keeps its controls inside them. When it is
false the pane host pads the
pane by the insets and consumes them (`HostPaddedPanel` in `workspace-pane-content.tsx`), so a pane
that knows nothing about insets still keeps its controls clear. Only plugin panels, whose UI cannot
know the insets, and the desktop-only browser leave them to the host. Declare a new kind false until
it handles them.

A pane that owns its insets runs its toolbars, rules and read-only content to the edges and keeps
its controls inside: a toolbar through `PaneContentToolbar`, a scroll view of controls through its
content container (`useHorizontalSafeAreaPadding`), and a block of controls in `RegionPaddedView`,
like the pull request pane's body below its toolbar.

## Surfaces that pad their own rows

The sidebars and sheets keep their own rows inside the side insets with one padding,
`PaddedSideInsetsView` or `PaddedSideInsetsProvider`, and publish it, so rules and backgrounds inside
can still reach the surface's edges (`packages/app/src/components/padded-side-insets.tsx`). Inside
such a surface:

- A panel or row with its own background or border takes `useFullBleedStyle()`, or is a
  `SheetFullBleedView` in a sheet: it reaches the surface's edges and pads its content back in. A
  row with its own horizontal padding adds the padded insets to it instead.
- A bare rule, like `MenuSeparator` or `SidebarSeparator`, takes `useEdgeBleedStyle()`.
- A vertical scroller reaches the edges and keeps its content inside the insets, so the rules in it
  are not clipped: the shared `ScrollView` and `FlatList` do it in a sheet, and `SheetScrollView`
  replaces a direct `BottomSheetScrollView`. Other scrollers take `useScrollBleedStyles()`.
- Content that is back at the edges, like a workspace pane in a sheet (`SheetFullBleedRegion`),
  clears the padded insets with `ClearPaddedSideInsets` so nothing extends twice.

Read these where the surface renders its content, not where it is declared: a sheet's content
renders at the sheet host.

## The top inset can be shared

The safe-area insets only say how far each edge is covered, not by what. On iPhone Duo unfolded in
portrait the top inset is 82pt, but only a 144pt camera and status block at the top-right corner
covers it. `UIView.reservedRegions(kind: .occlusion)` (iOS 27.1) reports those blocks, and
`packages/app/modules/paseo-reserved-regions` passes them to JS with the status bar frame.

`resolveTopBand` (`packages/app/src/components/top-band.ts`) decides whether the band is shareable:
only when no status bar spans it, which is how an iPhone with a notch or Dynamic Island stays as it
was. `useTopChromeInsets(rowHeight)` then replaces `insets.top` for a row at the top of a region:
the header, the sidebars and the toast offset put their row at the bottom of the band, beside the
occluded corners. Regions narrow the band's corners by edge, like the side insets.

The explorer panel pads its own top, so only its tab row sits beside the corner:
`TopRowExtraInsetsProvider` hands the band's corners to that row alone.

## Rules

- Pad a full-bleed row inside its background or border. `ScreenHeader` adds the insets to the row's
  inline padding so its bottom border still reaches the edge. `PaneContentToolbar` adds them to its
  `paddingLeft` and `paddingRight` props and overwrites horizontal padding in its `style`.
- The composer dock's content runs under the side insets; the controls in it inset themselves, like
  the compact New workspace pickers and the draft tab's setup fields.
- The chat's messages run under the side insets while its rows fill the width: the agent's text
  and the user message bubble alike. Once the rows reach `contentMaxWidth` they center where the
  composer centers, between the insets, as far as the free space allows (`resolveStreamColumn` in
  `packages/app/src/agent-stream/column.ts`). Controls stay inside the insets: the user message's
  buttons, and every row other than a message, like a tool call, a permission prompt or the turn
  footer (`useStreamColumnInsets()`, `useStreamControlsRowPadding()`).
- Pad a scroll view of controls through its content container, or give it margins when its style
  already sets horizontal padding. `paddingLeft` replaces `paddingHorizontal`; it doesn't add to it.
- A tree row adds `useTreeRowInsets()` to its padding, so the list and the row highlights reach the
  region's edges and the row's content stays inside (`packages/app/src/components/tree-primitives.tsx`).
- Inset an absolutely positioned control with offsets on its layer. Absolute children ignore their
  parent's padding: see the terminal's find bar and copy action in `terminal-pane.tsx`.
- Size against the window with `useWindowSafeAreaInsets()`. A region's narrowed insets give the
  wrong usable width.
- Anchored popovers clamp to the window's side insets, not the anchor's region: see `menu-overlay.tsx`
  and the combobox collision padding.
