import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWindowLayout } from "./context";
import { resolveVerticalBarEdge, type DesktopDivisionLayout } from "./model";

/**
 * The app row. It draws edge to edge: the regions in it take the side insets of the window edges
 * they touch (`HorizontalSafeAreaRegion`), and a vertical bar's actions sit in the inset on its
 * edge (`useVerticalBarInsets`).
 */
export function WindowLayoutSurface({
  children,
  style,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
}) {
  return <View style={style}>{children}</View>;
}

/**
 * The side insets a vertical bar of actions sits in, as left for this region. Text that runs
 * under the side insets, like the chat, a terminal grid or a diff, stops at them so the bar's
 * buttons never sit over it; backgrounds and rules still reach the edge.
 */
export function useVerticalBarInsets(): { left: number; right: number } {
  const edge = resolveVerticalBarEdge(useWindowLayout());
  const { left, right } = useSafeAreaInsets();
  return useMemo(
    () => ({ left: edge === "left" ? left : 0, right: edge === "right" ? right : 0 }),
    [edge, left, right],
  );
}

export function WindowLayoutDivisionGap({
  layout,
  sidebarVisible,
  compact,
}: {
  layout: DesktopDivisionLayout | null;
  sidebarVisible: boolean;
  compact: boolean;
}) {
  const style = useMemo(
    () => ({
      width: layout ? layout.gap + (sidebarVisible ? 0 : layout.sidebarWidth) : 0,
    }),
    [layout, sidebarVisible],
  );
  return !compact && layout ? <View style={[styles.divisionGap, style]} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  divisionGap: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
}));
