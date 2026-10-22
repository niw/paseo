import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { FileUploadStore } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("keeps the original file name for non-ASCII and punctuated names", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    for (const fileName of [
      "2026年9月绩效计划表.xlsx",
      "테스트 파일 (1).xlsx",
      "résumé [final] & notes, v2.pdf",
      "cafe\u0301 हिंदी.txt",
    ]) {
      const file = await uploadNamed(uploads, fileName);
      expect(file?.fileName).toBe(fileName);
      expect(basename(file!.path)).toBe(fileName);
      expect(readFileSync(file!.path, "utf8")).toBe("hello world");
    }
  });

  it("replaces path separators, control characters, and characters Windows rejects", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    await expect(uploadNamed(uploads, "../../etc/passwd")).resolves.toMatchObject({
      fileName: "passwd",
    });
    const backslashed = await uploadNamed(uploads, "dir\\name.txt");
    expect(backslashed?.fileName).not.toContain("\\");
    expect(backslashed?.fileName).toMatch(/name\.txt$/);
    await expect(uploadNamed(uploads, 'a<b>:"c|?*.txt')).resolves.toMatchObject({
      fileName: "a_b___c___.txt",
    });
    await expect(uploadNamed(uploads, "line\nbreak.txt")).resolves.toMatchObject({
      fileName: "line_break.txt",
    });
  });

  it("shortens a long non-ASCII name to the file system limit and keeps its extension", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    const file = await uploadNamed(uploads, `${"绩".repeat(100)}.xlsx`);

    expect(file?.fileName).toBe(`${"绩".repeat(83)}.xlsx`);
    expect(Buffer.byteLength(file!.fileName)).toBeLessThanOrEqual(255);
    expect(readFileSync(file!.path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    const uploadDir = dirname(path);
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(uploadedPath(paseoHome, "notes.txt"), "utf8")).toBe("hello world");
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    const path = uploadedPath(paseoHome, "new.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-duplicate"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const path = uploadedPath(paseoHome, "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-slow-active"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          id: expect.any(String),
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });
});

describe("workspace entry uploads", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the uploaded bytes into the workspace directory", async () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, "assets"));
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });
    const bytes = new Uint8Array([0, 255, 1, 254, 2]);

    uploads.beginEntryUpload(entryUploadRequest(workspace, "assets", "logo.png", bytes.length));
    await expect(uploads.receiveFrame(uploadBegins("req-entry"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadBytes("req-entry", bytes))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadEnds("req-entry"))).resolves.toEqual({
      type: "fs.entry.upload.response",
      payload: {
        cwd: workspace,
        parentPath: "assets",
        path: "assets/logo.png",
        success: true,
        error: null,
        requestId: "req-entry",
      },
    });
    expect(new Uint8Array(readFileSync(join(workspace, "assets", "logo.png")))).toEqual(bytes);
    expect(readdirSync(join(workspace, "assets"))).toEqual(["logo.png"]);
  });

  it("keeps the partial upload out of the target name until the upload ends", async () => {
    const workspace = makeWorkspace();
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    uploads.beginEntryUpload(entryUploadRequest(workspace, ".", "notes.txt", 11));
    await uploads.receiveFrame(uploadBegins("req-entry"));
    await uploads.receiveFrame(uploadChunk("req-entry", "hello"));

    expect(existsSync(join(workspace, "notes.txt"))).toBe(false);
    await uploads.receiveFrame(uploadChunk("req-entry", " world"));
    await uploads.receiveFrame(uploadEnds("req-entry"));
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("hello world");
  });

  it("refuses to replace an existing entry", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, "notes.txt"), "original");
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    uploads.beginEntryUpload(entryUploadRequest(workspace, ".", "notes.txt", 11));
    await expect(uploads.receiveFrame(uploadBegins("req-entry"))).resolves.toMatchObject({
      type: "fs.entry.upload.response",
      payload: { path: null, success: false, error: '"notes.txt" already exists' },
    });
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("original");
    expect(readdirSync(workspace)).toEqual(["notes.txt"]);
  });

  it("keeps an entry created while the upload was in flight", async () => {
    const workspace = makeWorkspace();
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    uploads.beginEntryUpload(entryUploadRequest(workspace, ".", "notes.txt", 11));
    await uploads.receiveFrame(uploadBegins("req-entry"));
    await uploads.receiveFrame(uploadChunk("req-entry", "hello world"));
    writeFileSync(join(workspace, "notes.txt"), "created meanwhile");

    await expect(uploads.receiveFrame(uploadEnds("req-entry"))).resolves.toMatchObject({
      payload: { success: false, error: '"notes.txt" already exists' },
    });
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("created meanwhile");
    expect(readdirSync(workspace)).toEqual(["notes.txt"]);
  });

  it("rejects a parent directory outside the workspace", async () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    symlinkSync(outside, join(workspace, "escape"));
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    uploads.beginEntryUpload(entryUploadRequest(workspace, "escape", "notes.txt", 11));
    await expect(uploads.receiveFrame(uploadBegins("req-entry"))).resolves.toMatchObject({
      payload: { success: false, error: "Access outside of workspace is not allowed" },
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects names with path separators", async () => {
    const workspace = makeWorkspace();
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    uploads.beginEntryUpload(entryUploadRequest(workspace, ".", "../notes.txt", 11));
    await expect(uploads.receiveFrame(uploadBegins("req-entry"))).resolves.toMatchObject({
      payload: { success: false, error: "Name cannot contain path separators" },
    });
  });

  it("removes the temporary file when the upload is cancelled", async () => {
    const workspace = makeWorkspace();
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    const cancel = uploads.beginEntryUpload(entryUploadRequest(workspace, ".", "notes.txt", 11));
    await uploads.receiveFrame(uploadBegins("req-entry"));
    await uploads.receiveFrame(uploadChunk("req-entry", "hello"));
    expect(readdirSync(workspace)).toHaveLength(1);

    await cancel();
    expect(readdirSync(workspace)).toEqual([]);
  });
});

function entryUploadRequest(cwd: string, parentPath: string, name: string, size: number) {
  return {
    type: "fs.entry.upload.request" as const,
    cwd,
    parentPath,
    name,
    size,
    requestId: "req-entry",
  };
}

function makeWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-workspace-")));
  tempDirs.push(root);
  return root;
}

let uploadCount = 0;

async function uploadNamed(uploads: FileUploadStore, fileName: string) {
  const requestId = `req-named-${uploadCount++}`;
  uploads.beginUpload({
    type: "file.upload.request",
    fileName,
    mimeType: "text/plain",
    size: 11,
    modifiedAt: "2026-05-02T00:00:00.000Z",
    requestId,
  });
  await uploads.receiveFrame(uploadBegins(requestId));
  await uploads.receiveFrame(uploadChunk(requestId, "hello world"));
  const response = await uploads.receiveFrame(uploadEnds(requestId));
  if (response?.type !== "file.upload.response") throw new Error("Expected an attachment upload");
  expect(response.payload.error).toBeNull();
  return response.payload.file;
}

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return uploadBytes(requestId, new TextEncoder().encode(text));
}

function uploadBytes(requestId: string, payload: Uint8Array): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload,
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}

function uploadedPath(paseoHome: string, fileName: string): string {
  const root = join(paseoHome, "uploads");
  const file = readdirSync(root)
    .map((id) => join(root, id, fileName))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`Upload file ${fileName} is missing`);
  return file;
}
