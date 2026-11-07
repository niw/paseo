import { ComposerDockBackground } from "@/composer/dock";
import { useCallback, useMemo, useState, type ReactNode } from "react";
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
import { TopChromeStack, WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

/**
 * The least width the left group needs: the sidebar toggle, a readable title and its actions.
 * Below it the right group moves to a second row instead of covering the left one.
 */
const MIN_LEFT_GROUP_WIDTH = 160;

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  /**
   * Controls at the end of the first row that stay there when the right group moves to a second
   * row, like the sidebar toggles.
   */
  trailing?: ReactNode;
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
  trailing,
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

  // The header's rows are a top chrome stack: beside a block that covers a top corner they share
  // the top inset instead of sitting below it. In a stack of its screen's top rows, like the
  // workspace header above its tab row, the outer stack places them.
  const rowHeight = isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT;
  const innerStyle = useMemo(() => ({ paddingTop: topPadding }), [topPadding]);
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
      <TopChromeStack estimatedHeight={rowHeight + topPadding}>
        <View style={innerStyle}>
          <WindowChromeSafeArea
            placement="inline"
            horizontalPadding={baseHorizontalPadding}
            // The row and its border run under the horizontal insets; its controls stay inside,
            // and the safe area moves its ends in past the window's top corners.
            paddingLeftExtra={insets.left}
            paddingRightExtra={insets.right}
            onLayout={onRowLayout}
            style={rowStyle}
          >
            <TitlebarDragRegion />
            <View style={styles.content} onLayout={stack.measureContent}>
              <View style={leftCombinedStyle}>{left}</View>
              {stack.stacked ? null : rightGroup}
            </View>
            {trailing}
          </WindowChromeSafeArea>
          {stack.stacked ? (
            // The second row sits below the desktop window controls. Beside a block that covers a
            // top corner, the stack still moves its ends in past it.
            <WindowChromeRegion corners="none">
              <WindowChromeSafeArea
                placement="inline"
                horizontalPadding={baseHorizontalPadding}
                paddingLeftExtra={insets.left}
                paddingRightExtra={insets.right}
                style={secondRowStyle}
              >
                {rightGroup}
              </WindowChromeSafeArea>
            </WindowChromeRegion>
          ) : null}
        </View>
      </TopChromeStack>
    </ComposerDockBackground>
  );
}

/**
 * Whether the right group moves to a second row. It decides from the width the left and right
 * groups share, measured on the view that holds them: it is the same in either arrangement, so
 * moving the group never flips the decision back. Summing the groups' own widths instead misses a
 * left group that is already squeezed to nothing, and the row never stacks.
 */
function useStackedRightGroup(hasRight: boolean) {
  const [contentWidth, setContentWidth] = useState(0);
  const [rightWidth, setRightWidth] = useState(0);
  const stacked =
    hasRight && contentWidth > 0 && rightWidth > 0
      ? contentWidth - rightWidth < MIN_LEFT_GROUP_WIDTH
      : false;
  const measureContent = useCallback((event: LayoutChangeEvent) => {
    setContentWidth(event.nativeEvent.layout.width);
  }, []);
  const measureRight = useCallback((event: LayoutChangeEvent) => {
    setRightWidth(event.nativeEvent.layout.width);
  }, []);
  return { stacked, measureContent, measureRight };
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
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
  content: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
