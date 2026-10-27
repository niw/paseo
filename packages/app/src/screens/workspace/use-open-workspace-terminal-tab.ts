import { useCallback } from "react";
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
