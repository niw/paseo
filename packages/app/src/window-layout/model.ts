export interface WindowLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowCornerRadii {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

export interface WindowLayout {
  bounds: WindowLayoutRect;
  verticalBarEdge: "none" | "leading" | "trailing";
  verticalBar: WindowLayoutRect | null;
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  /** Where a top bar rests, or null until the system resolves its top bar guide. */
  topBar?: WindowLayoutRect | null;
  /** Active system occlusions (status region, camera, Live Activities), margins included. */
  occlusions?: WindowLayoutRect[];
  /** The status bar's frame, or null where no status bar shows. */
  statusBar?: WindowLayoutRect | null;
  /** The radius of each window corner, which can differ per corner. Null before iOS 26. */
  cornerRadii?: WindowCornerRadii | null;
  divisions: WindowLayoutRect[];
}

/** The window's measured bottom clearance replaces the rectangular safe-area bottom. */
export function resolveSafeAreaInsets<Insets extends { bottom: number }>(
  systemInsets: Insets,
  layout: WindowLayout | null,
): Insets {
  const clearance = layout?.bottomClearance;
  return typeof clearance === "number" && clearance !== systemInsets.bottom
    ? { ...systemInsets, bottom: clearance }
    : systemInsets;
}

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

export function resolveWorkspaceActionPlacement(
  layout: WindowLayout | null,
): "header" | "vertical-bar" {
  return layout?.verticalBarEdge === "trailing" && layout.verticalBar !== null
    ? "vertical-bar"
    : "header";
}

/** The window edge whose side inset holds the vertical bar's actions, or null without one. */
export function resolveVerticalBarEdge(layout: WindowLayout | null): "left" | "right" | null {
  // The bar guide sits on the screen's right edge for the trailing bar.
  return resolveWorkspaceActionPlacement(layout) === "vertical-bar" ? "right" : null;
}

export function resolveWorkspaceBarActions(
  headerVariant: "compact" | "full",
): readonly ("tab-count" | "overflow" | "explorer")[] {
  return headerVariant === "compact"
    ? ["tab-count", "overflow", "explorer"]
    : ["overflow", "explorer"];
}

/** One book-like partition owns allocation; horizontal folds retain the normal flow. */
export function resolveDesktopDivisionLayout(input: {
  geometry: WindowLayout | null;
  windowWidth: number;
  windowHeight: number;
  leftInset: number;
  rightInset: number;
}): DesktopDivisionLayout | null {
  const { geometry, windowWidth, windowHeight, leftInset, rightInset } = input;
  if (
    !geometry ||
    Math.abs(geometry.bounds.width - windowWidth) > 0.5 ||
    Math.abs(geometry.bounds.height - windowHeight) > 0.5
  )
    return null;
  const divisions = geometry.divisions.filter(
    (frame) =>
      frame.width > 0 &&
      frame.height > frame.width &&
      frame.y < windowHeight &&
      frame.y + frame.height > 0,
  );
  if (divisions.length !== 1) return null;
  const division = divisions[0];
  const sidebarWidth = division.x - leftInset;
  const contentWidth = windowWidth - rightInset - division.x - division.width;
  if (sidebarWidth <= 0 || contentWidth <= 0) return null;
  return { sidebarWidth, gap: division.width, contentWidth };
}
