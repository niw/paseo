import { type ComponentProps, forwardRef, useMemo } from "react";
import {
  ClearPaddedSideInsets,
  useFullBleedStyle,
  usePaddedSideInsets,
  useScrollBleedStyles,
} from "@/components/padded-side-insets";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import type { BottomSheetScrollViewMethods } from "@gorhom/bottom-sheet";
import { View, type ViewProps } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * A sheet surface whose background reaches the sheet's edges while its content stays inside the
 * side safe-area insets the sheet padded. Render it inside the sheet; the insets are read there.
 */
export function SheetFullBleedView({ style, ...props }: ViewProps) {
  const fullBleedStyle = useFullBleedStyle();
  return <View {...props} style={[style, fullBleedStyle]} />;
}

/**
 * Hosts content that handles the side insets itself, like a workspace pane, at the sheet's full
 * width. Its content runs to the sheet's edges and sees the side insets again, so it keeps its
 * own controls inside them the same way it does outside a sheet.
 */
export function SheetFullBleedRegion({ style, children, ...props }: ViewProps) {
  const { left, right } = usePaddedSideInsets();
  const insets = useSafeAreaInsets();
  const regionStyle = useMemo(
    () => [style, { marginLeft: -left, marginRight: -right }],
    [left, right, style],
  );
  const regionInsets = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom, left, right }),
    [insets.top, insets.bottom, left, right],
  );
  // The content is back at the sheet's edges, so nothing inside it has a sheet inset to undo.
  return (
    <View {...props} style={regionStyle}>
      <ClearPaddedSideInsets>
        <SafeAreaInsetsContext.Provider value={regionInsets}>
          {children}
        </SafeAreaInsetsContext.Provider>
      </ClearPaddedSideInsets>
    </View>
  );
}

/**
 * A vertical BottomSheetScrollView that reaches the sheet's edges while its content stays inside
 * the side safe-area insets, so rules in it can run edge to edge. It reads the insets where it
 * renders, inside the sheet.
 */
export const SheetScrollView = forwardRef<
  BottomSheetScrollViewMethods,
  ComponentProps<typeof BottomSheetScrollView>
>(function SheetScrollView({ style, contentContainerStyle, ...props }, ref) {
  const bleed = useScrollBleedStyles();
  return (
    <BottomSheetScrollView
      {...props}
      ref={ref}
      style={[style, bleed.style]}
      contentContainerStyle={[contentContainerStyle, bleed.contentContainerStyle]}
    />
  );
});
