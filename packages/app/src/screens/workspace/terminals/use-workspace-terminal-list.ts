import { useFetchQuery } from "@/data/query";
import { queryClient } from "@/data/query-client";
import {
  buildTerminalsQueryKey,
  TERMINALS_QUERY_STALE_TIME,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

/** The workspace's terminals, from the query the workspace screen keeps current. */
export function useWorkspaceTerminalList(context: { serverId: string; workspaceId: string }) {
  const client = useSessionStore((state) => state.sessions[context.serverId]?.client ?? null);
  const workspaceDirectory = useWorkspaceDirectory(context.serverId, context.workspaceId);
  return useFetchQuery(
    {
      queryKey: buildTerminalsQueryKey(
        context.serverId,
        workspaceDirectory,
        context.workspaceId || null,
      ),
      enabled: Boolean(client && workspaceDirectory),
      queryFn: async (): Promise<ListTerminalsPayload> => {
        if (!client || !workspaceDirectory) {
          throw new Error("Workspace directory not found");
        }
        return client.listTerminals(workspaceDirectory, undefined, {
          workspaceId: context.workspaceId || undefined,
        });
      },
      dataShape: "list",
      staleTimeMs: TERMINALS_QUERY_STALE_TIME,
    },
    queryClient,
  );
}
