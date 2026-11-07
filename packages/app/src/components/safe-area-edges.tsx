import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type StyleProp, View, type ViewStyle, useWindowDimensions } from "react-native";
import {
  type EdgeInsets,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { subscribeReservedRegions } from "@/native/reserved-regions";
import type { ReservedRegionsSnapshot } from "@/native/reserved-regions-types";
import { resolveCornerClearance, resolveTopBand, type TopBand } from "./top-band";

export interface HorizontalSafeAreaEdges {
  left: boolean;
  right: boolean;
}

const WindowSafeAreaInsetsContext = createContext<EdgeInsets | null>(null);
const TopBandContext = createContext<TopBand | null>(null);
const TopCornerRadiiContext = createContext({ left: 0, right: 0 });
/** Which window edges this region touches, for the rounded corners on those edges. */
const RegionEdgesContext = createContext<HorizontalSafeAreaEdges>({ left: true, right: true });
/** A top row's controls sit about this tall, centered in the row. */
const TOP_ROW_CONTROL_HEIGHT = 32;
const TopRowExtraInsetsContext = createContext<{ left: number; right: number }>({
  left: 0,
  right: 0,
});

/**
 * Publishes the shareable part of the window's top inset; see `resolveTopBand`. Render it once,
 * under the app's SafeAreaProvider and above every HorizontalSafeAreaRegion.
 */
export function TopBandProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ReservedRegionsSnapshot | null>(null);
  useEffect(() => subscribeReservedRegions(setSnapshot), []);
  const { width: windowWidth } = useWindowDimensions();
  const { top: topInset } = useSafeAreaInsets();
  const value = useMemo(
    () => resolveTopBand({ windowWidth, topInset, snapshot }),
    [snapshot, topInset, windowWidth],
  );
  const topLeftRadius = snapshot?.cornerRadii?.topLeft ?? 0;
  const topRightRadius = snapshot?.cornerRadii?.topRight ?? 0;
  const topCornerRadii = useMemo(
    () => ({ left: topLeftRadius, right: topRightRadius }),
    [topLeftRadius, topRightRadius],
  );
  return (
    <TopCornerRadiiContext.Provider value={topCornerRadii}>
      <TopBandContext.Provider value={value}>{children}</TopBandContext.Provider>
    </TopCornerRadiiContext.Provider>
  );
}

/**
 * Where a row at the top of this region goes. When the top inset is shareable, the row sits at
 * the bottom of the band, beside the occluded corners, instead of below the whole band. Pass the
 * row's height; `paddingTop` replaces `insets.top` as its top padding.
 *
 * `paddingLeft` and `paddingRight` come on top of the side insets: the band's occluded corners,
 * and where the row runs into a rounded display corner, as it does on iPhone Duo where the top
 * inset is 0, just enough to bring the row's end controls inside the corner's arc.
 */
export function useTopChromeInsets(rowHeight: number): {
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
} {
  const band = useContext(TopBandContext);
  const radii = useContext(TopCornerRadiiContext);
  const edges = useContext(RegionEdgesContext);
  const insets = useSafeAreaInsets();
  const windowInsets = useWindowSafeAreaInsets();
  return useMemo(() => {
    const paddingTop = band ? Math.max(band.height - rowHeight, 0) : insets.top;
    const controlTop = paddingTop + Math.max(rowHeight - TOP_ROW_CONTROL_HEIGHT, 0) / 2;
    const cornerLeft = edges.left
      ? Math.max(resolveCornerClearance(radii.left, controlTop) - windowInsets.left, 0)
      : 0;
    const cornerRight = edges.right
      ? Math.max(resolveCornerClearance(radii.right, controlTop) - windowInsets.right, 0)
      : 0;
    return {
      paddingTop,
      paddingLeft: Math.max(band?.left ?? 0, cornerLeft),
      paddingRight: Math.max(band?.right ?? 0, cornerRight),
    };
  }, [band, edges, insets.top, radii, rowHeight, windowInsets.left, windowInsets.right]);
}

/**
 * Hands a region's top-band corners to the row at its top when the region pads its own top, like
 * the explorer panel: only that row sits beside the occluded corner.
 */
export function TopRowExtraInsetsProvider({
  value,
  children,
}: {
  value: { left: number; right: number };
  children: ReactNode;
}) {
  return (
    <TopRowExtraInsetsContext.Provider value={value}>{children}</TopRowExtraInsetsContext.Provider>
  );
}

/** Extra side padding for the row at the top of a region; see TopRowExtraInsetsProvider. */
export function useTopRowExtraInsets(): { left: number; right: number } {
  return useContext(TopRowExtraInsetsContext);
}

/**
 * Narrows the horizontal safe-area insets to the window edges this region touches.
 *
 * Side-by-side regions (sidebar, content, explorer) draw their backgrounds edge to edge and each
 * pads its own controls by the insets it receives. A region that does not touch an edge receives
 * 0 for it, so `useSafeAreaInsets()` below it is already correct and nobody pads twice. Insets can
 * land on either side: iPhone Duo puts an 84pt camera strip on the left or right.
 */
export function HorizontalSafeAreaRegion({
  edges,
  style,
  children,
}: {
  edges: HorizontalSafeAreaEdges;
  /** Renders the region as a view with this style. Without it the region adds no view. */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const windowInsets = useContext(WindowSafeAreaInsetsContext) ?? insets;
  const left = edges.left ? insets.left : 0;
  const right = edges.right ? insets.right : 0;
  const regionInsets = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom, left, right }),
    [insets.top, insets.bottom, left, right],
  );
  // The top band's occluded corners narrow the same way: a region keeps the corners on its edges.
  const band = useContext(TopBandContext);
  const bandLeft = band && edges.left ? band.left : 0;
  const bandRight = band && edges.right ? band.right : 0;
  const regionBand = useMemo(
    () => (band ? { height: band.height, left: bandLeft, right: bandRight } : null),
    [band, bandLeft, bandRight],
  );
  const parentEdges = useContext(RegionEdgesContext);
  const touchesLeft = parentEdges.left && edges.left;
  const touchesRight = parentEdges.right && edges.right;
  const regionEdges = useMemo(
    () => ({ left: touchesLeft, right: touchesRight }),
    [touchesLeft, touchesRight],
  );
  return (
    <WindowSafeAreaInsetsContext.Provider value={windowInsets}>
      <TopBandContext.Provider value={regionBand}>
        <RegionEdgesContext.Provider value={regionEdges}>
          <SafeAreaInsetsContext.Provider value={regionInsets}>
            {style === undefined ? children : <View style={style}>{children}</View>}
          </SafeAreaInsetsContext.Provider>
        </RegionEdgesContext.Provider>
      </TopBandContext.Provider>
    </WindowSafeAreaInsetsContext.Provider>
  );
}

/**
 * The window's insets before any region narrowed them. Use it to size things against the whole
 * window, such as the usable viewport width; pad with `useSafeAreaInsets()`.
 */
export function useWindowSafeAreaInsets(): EdgeInsets {
  const insets = useSafeAreaInsets();
  return useContext(WindowSafeAreaInsetsContext) ?? insets;
}

/** Padding that keeps a full-bleed row's controls inside this region's horizontal insets. */
export function useHorizontalSafeAreaPadding(): { paddingLeft: number; paddingRight: number } {
  const { left, right } = useSafeAreaInsets();
  return useMemo(() => ({ paddingLeft: left, paddingRight: right }), [left, right]);
}
