import type { RefCallback } from "react";
import type { View } from "react-native";
import type { SelectedFile } from "@/attachments/selected-file";

export interface ExplorerFileDropInput {
  enabled: boolean;
  onDrop: (parentPath: string, files: SelectedFile[]) => void;
}

export interface ExplorerFileDrop {
  ref: RefCallback<View> | undefined;
  /** The directory the files would land in while files are dragged over the tree. */
  targetDirectory: string | null;
}
