import { useCallback, useMemo, type ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConsumeSideInsets } from "@/components/safe-area-edges";
import { View } from "react-native";
import { useWorkspaceTabDrag } from "@/components/workspace-tab-drag-context";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanel } from "@/components/retained-panel";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
  type WorkspaceDesktopTabsRowProps,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SplitPane } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";

interface ExplorerSidebarDockProps extends Pick<
  WorkspaceDesktopTabsRowProps,
  | "setHoveredCloseTabKey"
  | "onCopyResumeCommand"
  | "onCopyAgentId"
  | "onCopyTerminalId"
  | "onCopyFilePath"
  | "onReloadAgent"
  | "onRenameTab"
  | "onCreateNewTab"
  | "onExitFocusMode"
> {
  hoveredCloseTabKey: string | null;
  onCloseTabsToLeft: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  closingTabIds: Set<string>;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  headerAction?: ReactNode;
}

/** A dock shell over the shared panel host. It owns no workspace-pane capabilities. */
export function ExplorerSidebarDock({
  pane,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  closingTabIds,
  onSelectTab,
  onCloseTab,
  onCreateNewTab,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onExitFocusMode,
  onReorderTabsInPane,
  buildPaneContentModel,
  headerAction,
}: ExplorerSidebarDockProps) {
  const { activeDragTabId, tabDropPreview, externalDndContext } = useWorkspaceTabDrag();
  const paneState = useMemo(() => deriveWorkspacePaneState({ pane, tabs: uiTabs }), [pane, uiTabs]);
  const tabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabId = paneState.activeTabId;
  const tabItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      tabs.map((tab) => ({
        tab,
        isActive: tab.tabId === activeTabId,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabId, closingTabIds, hoveredCloseTabKey, tabs],
  );
  const handleSelectTab = useCallback(
    (tabId: string) => onSelectTab(pane.id, tabId),
    [onSelectTab, pane.id],
  );
  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      onReorderTabsInPane(
        pane.id,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [onReorderTabsInPane, pane.id],
  );

  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => onCloseTabsToLeft(tabId, tabs),
    [onCloseTabsToLeft, tabs],
  );
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => onCloseTabsToRight(tabId, tabs),
    [onCloseTabsToRight, tabs],
  );
  const handleCloseOtherTabs = useCallback(
    (tabId: string) => onCloseOtherTabs(tabId, tabs),
    [onCloseOtherTabs, tabs],
  );

  // The rail and its divider reach the panel's edges under a side inset; the tabs and the header
  // action stay inside it. The rail pads the insets once, so the tabs row inside sees none.
  const insets = useSafeAreaInsets();
  return (
    <RetainedPanel active>
      <View style={styles.dock} testID="workspace-explorer-sidebar">
        <WindowChromeSafeArea
          placement="inline"
          style={styles.tabRail}
          paddingLeftExtra={insets.left}
          paddingRightExtra={insets.right}
        >
          <TitlebarDragRegion />
          {/* The rail moves its ends in past the window's top corners, so the tab row inside it
              does not. */}
          <WindowChromeRegion corners="none">
            <ConsumeSideInsets>
              <View style={styles.tabRow}>
                <WorkspaceDesktopTabsRow
                  host="explorer"
                  launchPurpose="supporting"
                  isFocused={isWorkspaceFocused}
                  ownsKeyboardShortcuts={false}
                  setHoveredCloseTabKey={setHoveredCloseTabKey}
                  onCopyResumeCommand={onCopyResumeCommand}
                  onCopyAgentId={onCopyAgentId}
                  onCopyTerminalId={onCopyTerminalId}
                  onCopyFilePath={onCopyFilePath}
                  onReloadAgent={onReloadAgent}
                  onRenameTab={onRenameTab}
                  onCloseTabsToLeft={handleCloseTabsToLeft}
                  onCloseTabsToRight={handleCloseTabsToRight}
                  onCloseOtherTabs={handleCloseOtherTabs}
                  focusModeEnabled={false}
                  onExitFocusMode={onExitFocusMode}
                  externalDndContext={externalDndContext}
                  paneId={pane.id}
                  tabs={tabItems}
                  normalizedServerId={normalizedServerId}
                  normalizedWorkspaceId={normalizedWorkspaceId}
                  activeDragTabId={activeDragTabId}
                  tabDropPreviewIndex={
                    tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
                  }
                  onNavigateTab={handleSelectTab}
                  onCloseTab={onCloseTab}
                  onCreateNewTab={onCreateNewTab}
                  onReorderTabs={handleReorderTabs}
                />
              </View>
              {headerAction ? <View style={styles.headerAction}>{headerAction}</View> : null}
            </ConsumeSideInsets>
          </WindowChromeRegion>
          <View pointerEvents="none" style={styles.tabRailDivider} />
        </WindowChromeSafeArea>
        {/* The tab rail is the panel's top row; the panes under it own no window corner. */}
        <WindowChromeRegion corners="none">
          <View style={styles.content}>
            <WorkspacePanelHost
              paneId={pane.id}
              tabs={tabs}
              activeTabId={activeTabId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused
              buildPaneContentModel={buildPaneContentModel}
            />
          </View>
        </WindowChromeRegion>
      </View>
    </RetainedPanel>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabRail: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabRow: {
    flex: 1,
    minWidth: 0,
  },
  headerAction: {
    marginRight: theme.spacing[1],
  },
  tabRailDivider: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
}));
