import { describe, expect, it } from "vitest";
import type { SelectedFile } from "@/attachments/selected-file";
import {
  MAX_EXPLORER_UPLOAD_BYTES,
  uploadExplorerFiles,
  type ExplorerUploadClient,
} from "./upload";

function selectedFile(fileName: string, bytes: Uint8Array): SelectedFile {
  return { fileName, mimeType: "application/octet-stream", readBytes: async () => bytes };
}

function recordingClient(
  respond: (name: string) => { path: string | null; success: boolean; error: string | null },
) {
  const calls: Array<{ cwd: string; parentPath: string; name: string; bytes: Uint8Array }> = [];
  const client: ExplorerUploadClient = {
    uploadFileEntry: async (input) => {
      calls.push(input);
      return respond(input.name);
    },
  };
  return { client, calls };
}

describe("explorer uploads", () => {
  it("uploads each file into the target directory in order", async () => {
    const { client, calls } = recordingClient((name) => ({
      path: `assets/${name}`,
      success: true,
      error: null,
    }));

    const outcomes = await uploadExplorerFiles({
      client,
      cwd: "/workspace",
      parentPath: "assets",
      files: [
        selectedFile("a.png", new Uint8Array([1])),
        selectedFile("b.png", new Uint8Array([2])),
      ],
    });

    expect(calls).toEqual([
      { cwd: "/workspace", parentPath: "assets", name: "a.png", bytes: new Uint8Array([1]) },
      { cwd: "/workspace", parentPath: "assets", name: "b.png", bytes: new Uint8Array([2]) },
    ]);
    expect(outcomes).toEqual([
      { fileName: "a.png", status: "uploaded", path: "assets/a.png" },
      { fileName: "b.png", status: "uploaded", path: "assets/b.png" },
    ]);
  });

  it("reports a failed file and continues with the rest", async () => {
    const { client } = recordingClient((name) =>
      name === "a.png"
        ? { path: null, success: false, error: '"a.png" already exists' }
        : { path: name, success: true, error: null },
    );

    const outcomes = await uploadExplorerFiles({
      client,
      cwd: "/workspace",
      parentPath: ".",
      files: [
        selectedFile("a.png", new Uint8Array([1])),
        selectedFile("b.png", new Uint8Array([2])),
      ],
    });

    expect(outcomes).toEqual([
      { fileName: "a.png", status: "failed", error: '"a.png" already exists' },
      { fileName: "b.png", status: "uploaded", path: "b.png" },
    ]);
  });

  it("does not send a file over the size limit", async () => {
    const { client, calls } = recordingClient(() => ({ path: "x", success: true, error: null }));

    const [outcome] = await uploadExplorerFiles({
      client,
      cwd: "/workspace",
      parentPath: ".",
      files: [selectedFile("big.bin", new Uint8Array(MAX_EXPLORER_UPLOAD_BYTES + 1))],
    });

    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ fileName: "big.bin", status: "failed" });
  });

  it("reports a connection failure as a failed file", async () => {
    const client: ExplorerUploadClient = {
      uploadFileEntry: async () => {
        throw new Error("Connection changed during file upload");
      },
    };

    const outcomes = await uploadExplorerFiles({
      client,
      cwd: "/workspace",
      parentPath: ".",
      files: [selectedFile("a.png", new Uint8Array([1]))],
    });

    expect(outcomes).toEqual([
      { fileName: "a.png", status: "failed", error: "Connection changed during file upload" },
    ]);
  });
});
