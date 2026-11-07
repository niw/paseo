import { useCallback, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  FileExplorerCloseGestureContext,
  useCloseFileExplorerGesture,
} from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { HorizontalSafeAreaRegion } from "@/components/safe-area-edges";
import { WindowChromeRegion } from "@/utils/desktop-window";
import { useExplorerGeometry } from "./geometry";
import type { ExplorerFrameProps } from "./frame-props";

function ExplorerFrameBase({
  children,
  surfaceColor,
  presentation,
  isOpen,
  isWorkspaceActive,
  persistenceKey,
}: ExplorerFrameProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const measureContainer = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { width, height } = nativeEvent.layout;
    if (width > 0 && height > 0) setContainerWidth(width);
  }, []);
  const overlay = presentation === "overlay";
  const settledOpen = useIsMobilePanelActive("file-explorer");
  const active = isWorkspaceActive && (overlay ? settledOpen : isOpen);
  const resizeEnabled = isWorkspaceActive && !overlay && isOpen;
  const { gesture, gestureRef } = useCloseFileExplorerGesture(isWorkspaceActive && overlay);
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resize = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const onResize = useCallback(
    (width: number) => resize(persistenceKey, width),
    [persistenceKey, resize],
  );
  const geometry = useExplorerGeometry({
    width: resolveExplorerSidebarWidth({ requestedWidth: storedWidth, containerWidth }),
    containerWidth,
    overlay,
    resizeEnabled,
    onResize,
  });
  return (
    <RetainedPanelActivity active={active}>
      <FileExplorerCloseGestureContext value={gestureRef}>
        <MobilePanelOverlay
          panel="file-explorer"
          closeGesture={gesture}
          presentation={presentation}
          dockVisible={isOpen}
          frameStyle={geometry.frameStyle}
          panelStyle={[{ backgroundColor: surfaceColor }, geometry.panelStyle]}
        >
          {/* The panel is a region like the column beside it: its panes run to its edges and
              keep their own controls inside the insets of the window edges it touches. */}
          <HorizontalSafeAreaRegion
            edges={overlay ? OVERLAY_SAFE_AREA_EDGES : DOCKED_SAFE_AREA_EDGES}
            style={styles.content}
          >
            {resizeEnabled ? geometry.resizeHandle : null}
            {/* The panel's tab row sits in the window's top-right corner, and in both top corners
                as an overlay. */}
            <WindowChromeRegion corners={overlay ? "both" : "top-right"}>
              {children}
            </WindowChromeRegion>
          </HorizontalSafeAreaRegion>
        </MobilePanelOverlay>
      </FileExplorerCloseGestureContext>
      <View pointerEvents="none" style={styles.measurement} onLayout={measureContainer} />
    </RetainedPanelActivity>
  );
}
export const ExplorerFrame = withUnistyles(ExplorerFrameBase, (theme) => ({
  surfaceColor: theme.colors.surfaceSidebar,
}));
const styles = StyleSheet.create({
  content: { flex: 1, minHeight: 0 },
  // Measure the workspace row even when the dock is closed. The gesture host stays in its slot.
  measurement: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
});
// Docked, the panel touches the window's right edge; as an overlay it covers the whole width.
const DOCKED_SAFE_AREA_EDGES = { left: false, right: true } as const;
const OVERLAY_SAFE_AREA_EDGES = { left: true, right: true } as const;
