import { parentExplorerPath } from "@/utils/explorer-paths";

/** The `dataSet` key a tree row carries so a drop over it resolves to a directory. */
export const EXPLORER_DROP_DIRECTORY_DATA_KEY = "explorerDropDirectory";
export const EXPLORER_DROP_DIRECTORY_SELECTOR = "[data-explorer-drop-directory]";

/** A directory row receives files itself. A file row sends them to its parent. */
export function explorerDropDirectory(entry: { path: string; kind: "file" | "directory" }): string {
  return entry.kind === "directory" ? entry.path : parentExplorerPath(entry.path);
}
