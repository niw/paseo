import type { SelectedFile } from "@/attachments/selected-file";
import { i18n } from "@/i18n/i18next";

// NOTE: The picked file is read into memory before it is streamed, so the cap
// keeps a phone from loading an arbitrarily large file.
export const MAX_EXPLORER_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface ExplorerUploadClient {
  uploadFileEntry(input: {
    cwd: string;
    parentPath: string;
    name: string;
    bytes: Uint8Array;
  }): Promise<{ path: string | null; success: boolean; error: string | null }>;
}

export type ExplorerUploadOutcome =
  | { fileName: string; status: "uploaded"; path: string }
  | { fileName: string; status: "failed"; error: string };

/** Uploads files one at a time so only one file's bytes are in flight. */
export async function uploadExplorerFiles(input: {
  client: ExplorerUploadClient;
  cwd: string;
  parentPath: string;
  files: SelectedFile[];
}): Promise<ExplorerUploadOutcome[]> {
  const outcomes: ExplorerUploadOutcome[] = [];
  for (const file of input.files) {
    outcomes.push(await uploadExplorerFile({ ...input, file }));
  }
  return outcomes;
}

async function uploadExplorerFile(input: {
  client: ExplorerUploadClient;
  cwd: string;
  parentPath: string;
  file: SelectedFile;
}): Promise<ExplorerUploadOutcome> {
  const { fileName } = input.file;
  try {
    const bytes = await input.file.readBytes();
    if (bytes.byteLength > MAX_EXPLORER_UPLOAD_BYTES) {
      return {
        fileName,
        status: "failed",
        error: i18n.t("workspace.fileExplorer.errors.uploadTooLarge", { fileName, size: "50MB" }),
      };
    }
    const payload = await input.client.uploadFileEntry({
      cwd: input.cwd,
      parentPath: input.parentPath,
      name: fileName,
      bytes,
    });
    if (!payload.success || !payload.path) {
      return {
        fileName,
        status: "failed",
        error: payload.error ?? i18n.t("workspace.fileExplorer.errors.uploadFailed"),
      };
    }
    return { fileName, status: "uploaded", path: payload.path };
  } catch (cause) {
    return {
      fileName,
      status: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
