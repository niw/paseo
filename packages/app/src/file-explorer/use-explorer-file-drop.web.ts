import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "react-native";
import type { SelectedFile } from "@/attachments/selected-file";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import { EXPLORER_DROP_DIRECTORY_DATA_KEY, EXPLORER_DROP_DIRECTORY_SELECTOR } from "./drop-target";
import type { ExplorerFileDrop, ExplorerFileDropInput } from "./explorer-file-drop.types";

/**
 * Accepts files dragged in from the OS onto the tree. The drop directory comes from the row
 * under the pointer, so tree rows must carry the drop-directory `dataSet` entry.
 */
export function useExplorerFileDrop({ enabled, onDrop }: ExplorerFileDropInput): ExplorerFileDrop {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [targetDirectory, setTargetDirectory] = useState<string | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const ref = useCallback((node: View | null) => {
    setElement(node as unknown as HTMLElement | null);
  }, []);

  useEffect(() => {
    if (!element || !enabled) {
      return;
    }
    const container = element;

    function handleDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setTargetDirectory(resolveDropDirectory(event.target));
    }

    function handleDragLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
      setTargetDirectory(null);
    }

    function handleDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setTargetDirectory(null);
      const files = droppedFiles(event.dataTransfer);
      if (files.length > 0) {
        onDropRef.current(resolveDropDirectory(event.target), files);
      }
    }

    container.addEventListener("dragenter", handleDragOver);
    container.addEventListener("dragover", handleDragOver);
    container.addEventListener("dragleave", handleDragLeave);
    container.addEventListener("drop", handleDrop);
    return () => {
      container.removeEventListener("dragenter", handleDragOver);
      container.removeEventListener("dragover", handleDragOver);
      container.removeEventListener("dragleave", handleDragLeave);
      container.removeEventListener("drop", handleDrop);
      setTargetDirectory(null);
    };
  }, [element, enabled]);

  return { ref, targetDirectory };
}

// NOTE: Rows dragged out of the tree carry the workspace-file type, not "Files", so they are
// left to the drop targets that accept them.
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function resolveDropDirectory(target: EventTarget | null): string {
  if (!(target instanceof Element)) return ".";
  const row = target.closest<HTMLElement>(EXPLORER_DROP_DIRECTORY_SELECTOR);
  return row?.dataset[EXPLORER_DROP_DIRECTORY_DATA_KEY] ?? ".";
}

// Dropped folders have no readable bytes, so only files are taken.
function droppedFiles(dataTransfer: DataTransfer | null): SelectedFile[] {
  return Array.from(dataTransfer?.items ?? []).flatMap((item) => {
    if (item.kind !== "file" || item.webkitGetAsEntry()?.isDirectory) return [];
    const file = item.getAsFile();
    if (!file) return [];
    return [
      {
        fileName: file.name,
        mimeType: file.type || getMimeTypeFromPath(file.name),
        readBytes: async () => new Uint8Array(await file.arrayBuffer()),
      },
    ];
  });
}
