import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/** Opens a terminal of the workspace in a tab, or focuses the tab that shows it. */
export function useOpenWorkspaceTerminalTab(
  serverId: string,
  workspaceId: string,
): (terminalId: string) => void {
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  return useCallback(
    (terminalId: string) => {
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!workspaceKey) {
        return;
      }
      openTab({ workspaceKey, target: { kind: "terminal", terminalId }, intent: "reveal" });
    },
    [openTab, serverId, workspaceId],
  );
}

/** Opens the terminal an agent runs in, which the daemon starts unless it runs. */
export function useOpenAgentTerminal(
  serverId: string,
  workspaceId: string,
): (agentId: string) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const openTerminalTab = useOpenWorkspaceTerminalTab(serverId, workspaceId);
  return useCallback(
    (agentId: string) => {
      if (!client) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }
      client.startAgentTerminal(agentId).then(openTerminalTab, (error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [client, openTerminalTab, t, toast],
  );
}
