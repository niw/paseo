import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react-native";
import { Text, View } from "react-native";
import invariant from "tiny-invariant";
import { deriveTerminalActivityStatusBucket } from "@getpaseo/protocol/terminal-activity";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useWorkspaceTerminalList } from "@/screens/workspace/terminals/use-workspace-terminal-list";
import { showExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function useTerminalPanelDescriptor(
  target: { kind: "terminal"; terminalId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const terminalsQuery = useWorkspaceTerminalList(context);
  const terminal =
    terminalsQuery.data?.terminals.find((entry) => entry.id === target.terminalId) ?? null;
  const label =
    trimNonEmpty(terminal?.title ?? terminal?.name ?? null) ??
    t("workspace.tabs.fallback.terminal");
  const agentSession = terminal?.agentSession;

  return {
    label,
    subtitle: t("workspace.tabs.fallback.terminal"),
    tooltip: label,
    titleState: terminalsQuery.isPending ? "loading" : "ready",
    icon: Terminal,
    statusBucket: deriveTerminalActivityStatusBucket(terminal?.activity),
    ...(agentSession ? { agentSession } : {}),
  };
}

function TerminalPanel() {
  const { serverId, workspaceId, target, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const isCompact = useIsCompactFormFactor();
  const handleOpenFileExplorer = useCallback(() => {
    if (!workspaceDirectory) {
      return;
    }
    showExplorerSidebar({
      isCompact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    });
  }, [isCompact, serverId, workspaceId, workspaceDirectory]);
  invariant(target.kind === "terminal", "TerminalPanel requires terminal target");

  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>Workspace directory not found.</Text>
      </View>
    );
  }

  return (
    <TerminalPane
      serverId={serverId}
      cwd={workspaceDirectory}
      terminalId={target.terminalId}
      isWorkspaceFocused={isWorkspaceFocused}
      isPaneFocused={isPaneFocused}
      onOpenFileExplorer={handleOpenFileExplorer}
      onOpenWorkspaceFile={openFileInWorkspace}
    />
  );
}

export const terminalPanelRegistration = definePanel("terminal", {
  component: TerminalPanel,
  useDescriptor: useTerminalPanelDescriptor,
});
