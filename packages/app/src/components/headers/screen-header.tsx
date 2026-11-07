import { ComposerDockBackground } from "@/composer/dock";
import { useTopChromeInsets } from "@/components/safe-area-edges";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

/**
 * The least width the left group needs: the sidebar toggle, a readable title and its actions.
 * Below it the right group moves to a second row instead of covering the left one.
 */
const MIN_LEFT_GROUP_WIDTH = 160;

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  left,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const baseHorizontalPadding = isMobile ? theme.spacing[2] : theme.spacing[3];

  // Beside an occluded corner the row shares the top inset instead of sitting below it.
  const rowHeight = isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT;
  const topChrome = useTopChromeInsets(rowHeight + topPadding);
  const innerStyle = useMemo(
    () => [styles.inner, { paddingTop: topChrome.paddingTop + topPadding }],
    [topChrome.paddingTop, topPadding],
  );
  const stack = useStackedRightGroup(right !== undefined && right !== null);
  const rowStyle = useMemo(
    () => [styles.row, (borderless || stack.stacked) && styles.borderless],
    [borderless, stack.stacked],
  );
  const secondRowStyle = useMemo(
    () => [styles.row, styles.secondRow, borderless && styles.borderless],
    [borderless],
  );
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  const rightCombinedStyle = useMemo(() => [styles.right, rightStyle], [rightStyle]);
  const rightGroup = (
    <View style={rightCombinedStyle} onLayout={stack.measureRight}>
      {right}
    </View>
  );

  return (
    <ComposerDockBackground style={styles.header} testID="composer-dock-header">
      <View style={innerStyle}>
        <WindowChromeSafeArea
          placement="inline"
          horizontalPadding={baseHorizontalPadding}
          // The row and its border run under the horizontal insets; its controls stay inside.
          paddingLeftExtra={insets.left + topChrome.paddingLeft}
          paddingRightExtra={insets.right + topChrome.paddingRight}
          onLayout={onRowLayout}
          style={rowStyle}
        >
          <TitlebarDragRegion />
          <View style={leftCombinedStyle} onLayout={stack.measureLeft}>
            {left}
          </View>
          {stack.stacked ? null : rightGroup}
        </WindowChromeSafeArea>
        {stack.stacked ? (
          <WindowChromeSafeArea
            placement="inline"
            horizontalPadding={baseHorizontalPadding}
            paddingLeftExtra={insets.left}
            paddingRightExtra={insets.right}
            style={secondRowStyle}
          >
            {rightGroup}
          </WindowChromeSafeArea>
        ) : null}
      </View>
    </ComposerDockBackground>
  );
}

/**
 * Whether the right group moves to a second row. It decides from the row's content width, which is
 * the same in either arrangement, so moving the group never flips the decision back.
 */
function useStackedRightGroup(hasRight: boolean) {
  const [contentWidth, setContentWidth] = useState(0);
  const [rightWidth, setRightWidth] = useState(0);
  const rightWidthRef = useRef(0);
  const stackedRef = useRef(false);
  const stacked =
    hasRight && contentWidth > 0 && rightWidth > 0
      ? contentWidth - rightWidth < MIN_LEFT_GROUP_WIDTH
      : false;
  stackedRef.current = stacked;
  const measureLeft = useCallback((event: LayoutChangeEvent) => {
    const leftWidth = event.nativeEvent.layout.width;
    // Side by side the left group gets what the right one leaves; stacked it gets the whole row.
    setContentWidth(stackedRef.current ? leftWidth : leftWidth + rightWidthRef.current);
  }, []);
  const measureRight = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    rightWidthRef.current = width;
    setRightWidth(width);
  }, []);
  return { stacked, measureLeft, measureRight };
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  inner: {},
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
  secondRow: {
    justifyContent: "flex-end",
  },
}));
