import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type StyleProp, View, type ViewStyle, useWindowDimensions } from "react-native";
import {
  type EdgeInsets,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { subscribeReservedRegions } from "@/native/reserved-regions";
import type { ReservedRegionsSnapshot } from "@/native/reserved-regions-types";
import { resolveTopBand, type TopBand } from "./top-band";

export interface HorizontalSafeAreaEdges {
  left: boolean;
  right: boolean;
}

/** What covers the window's top: the shareable band, the display's corners and the insets. */
export interface TopChromeGeometry {
  band: TopBand | null;
  topInset: number;
  /** The window's side insets, which a row at the top already pads by. */
  insets: { left: number; right: number };
  /** The radius of each top display corner. */
  radii: { left: number; right: number };
}

const NO_TOP_CHROME_GEOMETRY: TopChromeGeometry = {
  band: null,
  topInset: 0,
  insets: { left: 0, right: 0 },
  radii: { left: 0, right: 0 },
};

const WindowSafeAreaInsetsContext = createContext<EdgeInsets | null>(null);
const TopChromeGeometryContext = createContext<TopChromeGeometry>(NO_TOP_CHROME_GEOMETRY);
/** Which window edges this region touches, for the corners on those edges. */
const RegionEdgesContext = createContext<HorizontalSafeAreaEdges>({ left: true, right: true });

/**
 * Publishes what covers the window's top: the shareable part of the top inset (see
 * `resolveTopBand`) and the display's top corners. Top rows read it through `TopChromeStack`,
 * `WindowChromeSafeArea` and `useTopChromeInsets` in `utils/desktop-window.tsx`. Render it once,
 * under the app's SafeAreaProvider and above every HorizontalSafeAreaRegion.
 */
export function TopBandProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ReservedRegionsSnapshot | null>(null);
  useEffect(() => subscribeReservedRegions(setSnapshot), []);
  const { width: windowWidth } = useWindowDimensions();
  const { top: topInset, left: insetLeft, right: insetRight } = useSafeAreaInsets();
  const band = useMemo(
    () => resolveTopBand({ windowWidth, topInset, snapshot }),
    [snapshot, topInset, windowWidth],
  );
  const radiusLeft = snapshot?.cornerRadii?.topLeft ?? 0;
  const radiusRight = snapshot?.cornerRadii?.topRight ?? 0;
  const geometry = useMemo(
    () => ({
      band,
      topInset,
      insets: { left: insetLeft, right: insetRight },
      radii: { left: radiusLeft, right: radiusRight },
    }),
    [band, insetLeft, insetRight, radiusLeft, radiusRight, topInset],
  );
  return (
    <TopChromeGeometryContext.Provider value={geometry}>
      {children}
    </TopChromeGeometryContext.Provider>
  );
}

export function useTopChromeGeometry(): TopChromeGeometry {
  return useContext(TopChromeGeometryContext);
}

/** The window edges this region touches; see `HorizontalSafeAreaRegion`. */
export function useRegionEdges(): HorizontalSafeAreaEdges {
  return useContext(RegionEdgesContext);
}

/**
 * For a surface that pads its content by the side insets: the content sees none left, so nothing
 * pads them twice. The content still touches the same window edges, so a row at its top still
 * clears the corners.
 */
export function ConsumeSideInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const consumed = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom, left: 0, right: 0 }),
    [insets.top, insets.bottom],
  );
  return (
    <SafeAreaInsetsContext.Provider value={consumed}>{children}</SafeAreaInsetsContext.Provider>
  );
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
  const parentEdges = useContext(RegionEdgesContext);
  const touchesLeft = parentEdges.left && edges.left;
  const touchesRight = parentEdges.right && edges.right;
  const regionEdges = useMemo(
    () => ({ left: touchesLeft, right: touchesRight }),
    [touchesLeft, touchesRight],
  );
  return (
    <WindowSafeAreaInsetsContext.Provider value={windowInsets}>
      <RegionEdgesContext.Provider value={regionEdges}>
        <SafeAreaInsetsContext.Provider value={regionInsets}>
          {style === undefined ? children : <View style={style}>{children}</View>}
        </SafeAreaInsetsContext.Provider>
      </RegionEdgesContext.Provider>
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

/**
 * Padding that keeps a full-bleed row's controls inside this region's horizontal insets, on top of
 * the row's own horizontal padding, such as a scroll view's content container.
 */
export function useHorizontalSafeAreaPadding(padding = 0): {
  paddingLeft: number;
  paddingRight: number;
} {
  const { left, right } = useSafeAreaInsets();
  return useMemo(
    () => ({ paddingLeft: padding + left, paddingRight: padding + right }),
    [left, padding, right],
  );
}
