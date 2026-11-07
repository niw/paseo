import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WindowInsetsContext } from "./context";

export { useWindowInsets, useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap, useVerticalBarInsets } from "./surface";
export { WindowSafeArea, useWindowSafeAreaInsets } from "./window-safe-area";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, WindowLayout, WindowLayoutRect } from "./model";

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <WindowInsetsContext.Provider value={insets}>{children}</WindowInsetsContext.Provider>;
}
