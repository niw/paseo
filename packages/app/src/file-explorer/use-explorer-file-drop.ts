import type { ExplorerFileDrop, ExplorerFileDropInput } from "./explorer-file-drop.types";

export function useExplorerFileDrop(_input: ExplorerFileDropInput): ExplorerFileDrop {
  return { ref: undefined, targetDirectory: null };
}
