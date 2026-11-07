import { ComposerEditingScope } from "@/composer/editing-session";
import React, { useMemo, type ComponentType, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import invariant from "tiny-invariant";
import { RegionPaddedView } from "@/components/padded-side-insets";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getPanelRegistration } from "@/panels/panel-registry";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { RenderProfile } from "@/utils/render-profiler";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import type { OpenInSidePaneSource } from "@/workspace-tabs/open-beside";
import type { PaneHost } from "@/panels/panel-manifest";

export interface WorkspacePaneContentModel {
  key: string;
  Component: ComponentType;
  /** See `PanelManifest.ownsSideInsets`. */
  ownsSideInsets: boolean;
  paneContextValue: PaneContextValue;
}

export interface BuildWorkspacePaneContentModelInput {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  host: PaneHost;
  panelRevision?: number;
  onOpenTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onOpenPreferredTarget: (
    target: WorkspaceTabDescriptor["target"],
    source: OpenInSidePaneSource,
  ) => void;
  onOpenTargetToSide?: (target: WorkspaceTabDescriptor["target"]) => void;
  onCloseCurrentTab: () => void;
  onRetargetCurrentTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onSetCurrentTabState: (state: WorkspaceTabDescriptor["state"]) => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
  onOpenImportSheet: () => void;
}

export function buildWorkspacePaneContentModel({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
  host,
  panelRevision,
  onOpenTab,
  onOpenPreferredTarget,
  onOpenTargetToSide,
  onCloseCurrentTab,
  onRetargetCurrentTab,
  onSetCurrentTabState,
  onOpenWorkspaceFile,
  onOpenImportSheet,
}: BuildWorkspacePaneContentModelInput): WorkspacePaneContentModel {
  const registration = getPanelRegistration(tab.kind);
  invariant(registration, `No panel registration for kind: ${tab.kind}`);
  return {
    key: `${normalizedServerId}:${normalizedWorkspaceId}:${tab.tabId}`,
    Component: registration.component,
    ownsSideInsets: registration.ownsSideInsets,
    paneContextValue: {
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      host,
      tabId: tab.tabId,
      target: tab.target,
      state: tab.state,
      panelRevision,
      openTab: onOpenTab,
      openPreferredTarget: onOpenPreferredTarget,
      openTargetToSide: onOpenTargetToSide,
      closeCurrentTab: onCloseCurrentTab,
      retargetCurrentTab: onRetargetCurrentTab,
      setCurrentTabState: onSetCurrentTabState,
      openFileInWorkspace: onOpenWorkspaceFile,
      openImportSheet: onOpenImportSheet,
    },
  };
}

export interface WorkspacePaneContentProps {
  content: WorkspacePaneContentModel;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: () => void;
}

export function WorkspacePaneContent({
  content,
  isWorkspaceFocused,
  isPaneFocused,
  onFocusPane,
}: WorkspacePaneContentProps) {
  const { Component, key, paneContextValue } = content;
  const openTab = useStableEvent(paneContextValue.openTab);
  const openPreferredTarget = useStableEvent(paneContextValue.openPreferredTarget);
  const openTargetToSide = useStableEvent(paneContextValue.openTargetToSide ?? (() => undefined));
  const closeCurrentTab = useStableEvent(paneContextValue.closeCurrentTab);
  const retargetCurrentTab = useStableEvent(paneContextValue.retargetCurrentTab);
  const setCurrentTabState = useStableEvent(paneContextValue.setCurrentTabState);
  const openFileInWorkspace = useStableEvent(paneContextValue.openFileInWorkspace);
  const openImportSheet = useStableEvent(paneContextValue.openImportSheet);
  const stablePaneContextValue = useMemo(
    () => ({
      serverId: paneContextValue.serverId,
      workspaceId: paneContextValue.workspaceId,
      host: paneContextValue.host,
      tabId: paneContextValue.tabId,
      target: paneContextValue.target,
      state: paneContextValue.state,
      panelRevision: paneContextValue.panelRevision,
      openTab,
      openPreferredTarget,
      openTargetToSide: paneContextValue.openTargetToSide ? openTargetToSide : undefined,
      closeCurrentTab,
      retargetCurrentTab,
      setCurrentTabState,
      openFileInWorkspace,
      openImportSheet,
    }),
    [
      closeCurrentTab,
      openFileInWorkspace,
      openImportSheet,
      openTab,
      openPreferredTarget,
      openTargetToSide,
      paneContextValue.serverId,
      paneContextValue.panelRevision,
      paneContextValue.tabId,
      paneContextValue.target,
      paneContextValue.state,
      paneContextValue.workspaceId,
      paneContextValue.host,
      paneContextValue.openTargetToSide,
      retargetCurrentTab,
      setCurrentTabState,
    ],
  );
  const paneFocusValue = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused,
        isPaneFocused,
        onFocusPane,
      }),
    [isPaneFocused, isWorkspaceFocused, onFocusPane],
  );

  return (
    <RenderProfile
      id={`WorkspacePaneContent:${paneContextValue.target.kind}:${paneContextValue.tabId}`}
    >
      <PaneProvider value={stablePaneContextValue}>
        <PaneFocusProvider value={paneFocusValue}>
          <ComposerEditingScope
            tabId={paneContextValue.tabId}
            targetKey={JSON.stringify(paneContextValue.target)}
          >
            {content.ownsSideInsets ? (
              <Component key={key} />
            ) : (
              <HostPaddedPanel>
                <Component key={key} />
              </HostPaddedPanel>
            )}
          </ComposerEditingScope>
        </PaneFocusProvider>
      </PaneProvider>
    </RenderProfile>
  );
}

/**
 * Pads a panel that does not handle the side safe-area insets itself, so its controls stay clear
 * of them wherever the pane sits: the column, the explorer or a sheet. The panel sees no insets.
 */
function HostPaddedPanel({ children }: { children: ReactNode }) {
  return <RegionPaddedView style={styles.hostPaddedPanel}>{children}</RegionPaddedView>;
}

const styles = StyleSheet.create({ hostPaddedPanel: { flex: 1, minWidth: 0, minHeight: 0 } });
