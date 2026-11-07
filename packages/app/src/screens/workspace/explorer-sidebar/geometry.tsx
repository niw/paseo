import { useCallback, useMemo, useState } from "react";
import { useTopChromeInsets } from "@/components/safe-area-edges";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HEADER_TOP_PADDING_MOBILE, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import {
  beginExplorerSidebarResize,
  finishExplorerSidebarResize,
  reconcileExplorerSidebarResize,
  resolveExplorerSidebarFrameWidth,
  resolveExplorerSidebarWidth,
  type ExplorerSidebarResize,
} from "@/components/explorer-sidebar-layout";
import type { ExplorerGeometryInput, ExplorerGeometry } from "./geometry-types";
export function useExplorerGeometry({
  width,
  containerWidth,
  overlay,
  resizeEnabled,
  onResize,
}: ExplorerGeometryInput): ExplorerGeometry {
  const insets = useSafeAreaInsets();
  // The panel's top row is its tab row: it shares a shareable top band.
  const overlayTopPadding = overlay ? HEADER_TOP_PADDING_MOBILE : 0;
  const topChrome = useTopChromeInsets(WORKSPACE_SECONDARY_HEADER_HEIGHT.md + overlayTopPadding);
  const resizeWidth = useSharedValue(width);
  const startWidth = useSharedValue(width);
  const resize = useSharedValue<ExplorerSidebarResize | null>(null);
  const [resizePressed, setResizePressed] = useState(false);
  useAnimatedReaction(
    () => ({ resize: resize.value, width, containerWidth, overlay, resizeEnabled }),
    ({ resize: currentResize, ...allocation }) => {
      const nextResize = reconcileExplorerSidebarResize(currentResize, allocation);
      if (nextResize !== currentResize) resize.value = nextResize;
    },
    [containerWidth, overlay, resize, resizeEnabled, width],
  );

  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(resizeEnabled)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => scheduleOnRN(showResizeGrip))
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          const currentWidth = resolveExplorerSidebarFrameWidth({
            width,
            containerWidth,
            overlay,
            resizeEnabled,
            resize: resize.value,
            resizeWidth: resizeWidth.value,
          });
          resize.value = beginExplorerSidebarResize(resize.value, {
            width,
            containerWidth,
            overlay,
            resizeEnabled,
          });
          startWidth.value = currentWidth + event.translationX;
          resizeWidth.value = currentWidth;
        })
        .onUpdate((event) => {
          if (!resize.value) return;
          resizeWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidth.value - event.translationX,
            containerWidth,
          });
        })
        .onEnd((_event, success) => {
          {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, success);
            if (!success || !resize.value) return;
          }
          runOnJS(onResize)(resizeWidth.value);
        })
        .onFinalize((_event, success) => {
          if (!success) {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, false);
          }
          scheduleOnRN(hideResizeGrip);
        }),
    [
      resizeEnabled,
      onResize,
      containerWidth,
      hideResizeGrip,
      overlay,
      resize,
      resizeWidth,
      showResizeGrip,
      startWidth,
      width,
    ],
  );
  // Reanimated retains the last animated value when its style is removed. Keep this
  // style attached across folding and explicitly size overlays to the workspace viewport.
  // The docked panel grows by the right edge's inset so its content keeps its width.
  const dockInsetRight = insets.right;
  const animatedWidthStyle = useAnimatedStyle(() => {
    if (overlay) return { width: containerWidth };
    return {
      width:
        resolveExplorerSidebarFrameWidth({
          width,
          containerWidth,
          overlay,
          resizeEnabled,
          resize: resize.value,
          resizeWidth: resizeWidth.value,
        }) + dockInsetRight,
    };
  }, [containerWidth, dockInsetRight, overlay, resizeEnabled, width]);
  return {
    frameStyle: animatedWidthStyle,
    panelStyle: {
      paddingTop: topChrome.paddingTop + overlayTopPadding,
    },
    resizeHandle: (
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        pressed={resizePressed}
        testID="native-explorer-sidebar-resize-handle"
      />
    ),
  };
}
