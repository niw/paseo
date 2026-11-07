import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { WindowLayout } from "./model";

export const WindowLayoutContext = createContext<WindowLayout | null>(null);

/**
 * The insets of the whole window, published by `WindowLayoutProvider` before any surface (a
 * sheet tab, for one) narrows the insets its content reads.
 */
export const WindowInsetsContext = createContext<EdgeInsets | null>(null);

export function useWindowInsets(): EdgeInsets | null {
  return useContext(WindowInsetsContext);
}

export function useWindowLayout(): WindowLayout | null {
  const layout = useContext(WindowLayoutContext);
  const { width, height } = useWindowDimensions();
  return layout &&
    Math.abs(layout.bounds.width - width) <= 0.5 &&
    Math.abs(layout.bounds.height - height) <= 0.5
    ? layout
    : null;
}
