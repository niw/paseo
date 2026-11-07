import { useCallback, useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PaddedSideInsetsProvider } from "@/components/padded-side-insets";
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
import {
  HorizontalSafeAreaRegion,
  TopRowExtraInsetsProvider,
  useTopChromeInsets,
} from "@/components/safe-area-edges";
import { HEADER_TOP_PADDING_MOBILE, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { useExplorerGeometry } from "./geometry";
import type { ExplorerFrameProps } from "./frame-props";

function ExplorerFrameBase({
  children,
  surfaceColor,
  presentation,
  isOpen,
  isWorkspaceActive,
  persistenceKey,
  containerWidth,
}: ExplorerFrameProps) {
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
  // Only the tab row at the panel's top sits beside an occluded corner of a shared top band.
  const topChrome = useTopChromeInsets(
    WORKSPACE_SECONDARY_HEADER_HEIGHT + (overlay ? HEADER_TOP_PADDING_MOBILE : 0),
  );
  const topRowExtraInsets = useMemo(
    () => ({ left: topChrome.paddingLeft, right: topChrome.paddingRight }),
    [topChrome.paddingLeft, topChrome.paddingRight],
  );
  // The panel pads its side insets once (see the geometry); its rules still reach its edges.
  const { left: insetLeft, right: insetRight } = useSafeAreaInsets();
  const paddedLeft = overlay ? insetLeft : 0;
  const paddedInsets = useMemo(
    () => ({ left: paddedLeft, right: insetRight }),
    [paddedLeft, insetRight],
  );
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
          <HorizontalSafeAreaRegion edges={safeAreaEdges} style={styles.content}>
            {resizeEnabled ? geometry.resizeHandle : null}
            <PaddedSideInsetsProvider value={paddedInsets}>
              <TopRowExtraInsetsProvider value={topRowExtraInsets}>
                {children}
              </TopRowExtraInsetsProvider>
            </PaddedSideInsetsProvider>
          </HorizontalSafeAreaRegion>
        </MobilePanelOverlay>
      </FileExplorerCloseGestureContext>
    </RetainedPanelActivity>
  );
}
export const ExplorerFrame = withUnistyles(ExplorerFrameBase, (theme) => ({
  surfaceColor: theme.colors.surfaceSidebar,
}));
const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } });
// The panel pads its own safe-area insets, so its content has none left.
const safeAreaEdges = { left: false, right: false } as const;
