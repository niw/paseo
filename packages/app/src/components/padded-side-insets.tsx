import { createContext, useContext, useMemo, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";

/**
 * The side safe-area insets a surface padded its content by. A sheet, a sidebar or the explorer
 * panel keeps its controls inside the insets with one padding, and publishes it here so the rules
 * and backgrounds inside can still reach the surface's edges. Zero outside such a surface.
 */
export interface PaddedSideInsets {
  left: number;
  right: number;
}

const NO_PADDED_SIDE_INSETS: PaddedSideInsets = { left: 0, right: 0 };

const PaddedSideInsetsContext = createContext<PaddedSideInsets>(NO_PADDED_SIDE_INSETS);

/** Publishes the side insets this surface padded its content by. */
export function PaddedSideInsetsProvider({
  value,
  children,
}: {
  value: PaddedSideInsets;
  children: ReactNode;
}) {
  return (
    <PaddedSideInsetsContext.Provider value={value}>{children}</PaddedSideInsetsContext.Provider>
  );
}

/** Content that sits back at the surface's edges has no padded insets to undo. */
export function ClearPaddedSideInsets({ children }: { children: ReactNode }) {
  return (
    <PaddedSideInsetsContext.Provider value={NO_PADDED_SIDE_INSETS}>
      {children}
    </PaddedSideInsetsContext.Provider>
  );
}

export function usePaddedSideInsets(): PaddedSideInsets {
  return useContext(PaddedSideInsetsContext);
}

/**
 * For a panel or row with its own background or border: it reaches the surface's edges past the
 * padded insets and pads its content back inside them.
 */
export function useFullBleedStyle(): {
  marginLeft: number;
  marginRight: number;
  paddingLeft: number;
  paddingRight: number;
} {
  const { left, right } = usePaddedSideInsets();
  return useMemo(
    () => ({ marginLeft: -left, marginRight: -right, paddingLeft: left, paddingRight: right }),
    [left, right],
  );
}

/** For a bare rule, like a separator: it reaches the surface's edges past the padded insets. */
export function useEdgeBleedStyle(): { marginLeft: number; marginRight: number } {
  const { left, right } = usePaddedSideInsets();
  return useMemo(() => ({ marginLeft: -left, marginRight: -right }), [left, right]);
}

/**
 * For a vertical scroller: it reaches the surface's edges, so the rules in it are not clipped, and
 * its content stays inside the padded insets. Use `style` on the scroller and
 * `contentContainerStyle` on its content.
 */
export function useScrollBleedStyles(): {
  style: { marginLeft: number; marginRight: number };
  contentContainerStyle: { marginLeft: number; marginRight: number };
} {
  const { left, right } = usePaddedSideInsets();
  return useMemo(
    () => ({
      style: { marginLeft: -left, marginRight: -right },
      contentContainerStyle: { marginLeft: left, marginRight: right },
    }),
    [left, right],
  );
}

/**
 * A view that pads its content by side insets and publishes them, so the rules inside can still
 * reach its edges. Sidebars and the explorer panel use it to keep their controls clear of a side
 * camera strip.
 */
export function PaddedSideInsetsView({
  insets,
  style,
  children,
  ...props
}: ViewProps & { insets: PaddedSideInsets }) {
  const paddedStyle = useMemo(
    () => [style, { paddingLeft: insets.left, paddingRight: insets.right }],
    [insets.left, insets.right, style],
  );
  return (
    <View {...props} style={paddedStyle}>
      <PaddedSideInsetsContext.Provider value={insets}>{children}</PaddedSideInsetsContext.Provider>
    </View>
  );
}
