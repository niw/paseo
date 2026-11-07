# Safe area

Backgrounds and read-only content run edge to edge: the terminal grid and file text can sit under a
side inset. Chat rows are the exception: they share the composer's column, so the chat scrolls edge
to edge but its text lines up with the composer. Controls stay inside the safe-area insets on all four sides: buttons,
inputs, pickers, list rows you tap, and the keys of the terminal key bar. Rules, like borders and
separators, are part of the background and reach the edge too.

Don't assume an inset's edge. On iPhone Duo the camera and status bar sit in an 84pt strip on the
left or right, with a top inset of 0, in both the folded portrait (compact) and unfolded landscape
(wide) postures. Only the unfolded portrait posture has a top status bar. The bottom inset stays
34pt in landscape.

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

The same hook keeps a top row's end controls clear of the display's rounded corners where the top
inset is 0, like iPhone Duo with its camera strip on the side. It moves only the row's ends inward,
by the depth of the corner's arc at the controls' height (`resolveCornerClearance`); the row keeps
its height and position. The native module reads each corner's radius from a
window-filling view with a container-concentric corner configuration (`effectiveRadius(corner:)`,
iOS 26). The radii differ per corner: iPhone Duo folded has 8pt corners on the hinge side and 59pt
on the other.

## Regions own edges

The app draws side-by-side regions: the sidebar, the content, and the docked explorer. Each region
takes the horizontal insets of the window edges it touches, and nobody else pads them.
`HorizontalSafeAreaRegion` (`packages/app/src/components/safe-area-edges.tsx`) narrows
`SafeAreaInsetsContext` for its subtree, so `useSafeAreaInsets()` below it already returns 0 for an
edge the region does not touch.

| Region                  | Declared in                                           | Edges                                             |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| App sidebar (wide)      | `app/_layout.tsx`                                     | left                                              |
| App content             | `app/_layout.tsx`                                     | right, plus left when no sidebar shows            |
| Workspace column (wide) | `screens/workspace/workspace-screen.tsx`              | left, plus right when no explorer docks           |
| Explorer panel          | `screens/workspace/explorer-sidebar/frame.tsx`        | none: the panel pads right, or both as an overlay |
| Settings sidebar/detail | `screens/settings-screen.tsx`                         | left / right                                      |
| Sheet content           | `components/ui/isolated-bottom-sheet-modal/index.tsx` | none: the sheet pads both itself                  |

A region that pads its own insets passes none on (`edges` all false), the same way
`SheetBottomInset` consumes the bottom inset (see [floating-panels.md](floating-panels.md#gotcha-8--read-safe-area-insets-where-the-overlay-draws)).

A sidebar or explorer that takes an inset grows by it, so its rows keep their width.

## Rules

- Pad a full-bleed row inside its background or border. `ScreenHeader` adds the insets to the row's
  inline padding so its bottom border still reaches the edge.
- The composer dock's content runs under the side insets; the controls in it inset themselves, like
  the compact New workspace pickers and the draft tab's setup fields.
  The chat's rows take the composer's column: inside the insets, centered where the composer
  centers once they reach `contentMaxWidth`, so no gap opens on the far side of an inset.
- Pad a scroll view of controls through its content container, or give it margins when its style
  already sets horizontal padding. `paddingLeft` replaces `paddingHorizontal`; it doesn't add to it.
- Inset an absolutely positioned control with offsets on its layer. Absolute children ignore their
  parent's padding: see the terminal's find bar and copy action in `terminal-pane.tsx`.
- A surface that pads its content by the side insets once publishes the padding, so rules and
  backgrounds inside it still reach its edges (`packages/app/src/components/padded-side-insets.tsx`).
  Sheets, the sidebars, the settings sidebar and the explorer panel do this, through
  `PaddedSideInsetsView` or `PaddedSideInsetsProvider`. Inside such a surface:
  - A panel or row with its own background or border takes `useFullBleedStyle()`, or is a
    `SheetFullBleedView` in a sheet: it reaches the surface's edges and pads its content back in.
    A row with its own horizontal padding adds the padded insets to it instead.
  - A bare rule, like `MenuSeparator` or `SidebarSeparator`, takes `useEdgeBleedStyle()`.
  - A vertical scroller reaches the edges and keeps its content inside the insets, so the rules in
    it are not clipped: the shared `ScrollView` and `FlatList` do it in a sheet, and
    `SheetScrollView` replaces a direct `BottomSheetScrollView`. Other scrollers take
    `useScrollBleedStyles()`.
  - Content that is already back at the edges, like a workspace pane in a sheet
    (`SheetFullBleedRegion`) or the explorer's tabs inside its full-bleed rail, clears the padded
    insets with `ClearPaddedSideInsets` so nothing extends twice.

  Read these where the surface renders its content, not where it is declared: a sheet's content
  renders at the sheet host.

- Size against the window with `useWindowSafeAreaInsets()`. A region's narrowed insets give the
  wrong usable width.
- Anchored popovers clamp to the window's side insets, not the anchor's region: see `menu-overlay.tsx`
  and the combobox collision padding.
