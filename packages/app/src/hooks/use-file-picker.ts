import { useCallback, useRef } from "react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { isWeb } from "@/constants/platform";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import type { SelectedFile } from "@/attachments/selected-file";

// NOTE: Electron uses the browser input too. It opens the native dialog and hands back `File`
// objects, so the bytes are read directly instead of through a desktop IPC round trip.
function pickFilesWithWebInput(): Promise<SelectedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }

      const result: SelectedFile[] = [];
      for (const file of files) {
        result.push({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        });
      }
      resolve(result);
    });

    input.addEventListener("cancel", () => {
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();

    // Clean up after a short delay to allow the change event to fire
    setTimeout(() => {
      input.remove();
    }, 60_000);
  });
}

async function pickFilesWithDocumentPicker(): Promise<SelectedFile[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  return result.assets.map((asset) => ({
    fileName: asset.name,
    mimeType: asset.mimeType ?? getMimeTypeFromPath(asset.name),
    readBytes: () => new File(asset.uri).bytes(),
  }));
}

export function useFilePicker() {
  const isPickingRef = useRef(false);

  const pickFiles = useCallback(async (): Promise<SelectedFile[] | null> => {
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;

    try {
      if (isWeb) {
        return await pickFilesWithWebInput();
      }

      return await pickFilesWithDocumentPicker();
    } catch (error) {
      console.error("[FilePicker] Failed to pick files:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickFiles };
}
