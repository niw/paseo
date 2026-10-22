import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  FileEntryUploadRequest,
  FileEntryUploadResponse,
  FileUploadRequest,
  FileUploadResponse,
} from "../messages.js";
import { commitExplorerUpload, prepareExplorerUpload } from "../file-explorer/service.js";

type UploadResponse = FileUploadResponse | FileEntryUploadResponse;

/** Where an upload's bytes land and how the finished file is reported. */
interface UploadTarget {
  /** Creates an empty writable file and returns its path. */
  open(): Promise<string>;
  commit(): Promise<void>;
  discard(): Promise<void>;
  respond(error: string | null): UploadResponse;
}

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
}

interface PendingUpload {
  requestId: string;
  source: object;
  target: UploadTarget;
  completed: boolean;
  finished(response: UploadResponse | null): void;
  size: number;
  writePath: string | null;
  receivedBytes: number;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  cleanup?: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly defaultSource = {};
  private readonly pending = new Map<object, Map<string, PendingUpload>>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  /** Receives a chat attachment into `$PASEO_HOME/uploads/<id>/`. */
  beginUpload(
    request: FileUploadRequest,
    source: object = this.defaultSource,
    finished: (response: FileUploadResponse | null) => void = () => {},
  ): () => Promise<void> {
    const target = this.createAttachmentTarget(request);
    return this.begin({
      requestId: request.requestId,
      size: request.size,
      target,
      source,
      finished: (response) => finished(response?.type === "file.upload.response" ? response : null),
    });
  }

  /** Receives a file into a workspace directory. */
  beginEntryUpload(
    request: FileEntryUploadRequest,
    source: object = this.defaultSource,
    finished: (response: FileEntryUploadResponse | null) => void = () => {},
  ): () => Promise<void> {
    return this.begin({
      requestId: request.requestId,
      size: request.size,
      target: createWorkspaceTarget(request),
      source,
      finished: (response) =>
        finished(response?.type === "fs.entry.upload.response" ? response : null),
    });
  }

  private begin(input: {
    requestId: string;
    size: number;
    target: UploadTarget;
    source: object;
    finished: (response: UploadResponse | null) => void;
  }): () => Promise<void> {
    const { requestId, source } = input;
    const existingUpload = this.pending.get(source)?.get(requestId);
    if (existingUpload) void this.cancel(existingUpload).catch(() => {});
    const upload: PendingUpload = {
      requestId,
      source,
      target: input.target,
      completed: false,
      finished: input.finished,
      size: input.size,
      writePath: null,
      receivedBytes: 0,
      staleTimeout: this.createStaleUploadTimeout(source, requestId),
      queue: Promise.resolve(),
    };
    const uploads = this.pending.get(source) ?? new Map<string, PendingUpload>();
    uploads.set(requestId, upload);
    this.pending.set(source, uploads);
    return () => this.cancel(upload);
  }

  private createAttachmentTarget(request: FileUploadRequest): UploadTarget {
    const fileName = sanitizeFileName(request.fileName);
    const id = `upload_${randomUUID()}`;
    const uploadDir = join(this.paseoHome, "uploads", id);
    const uploadPath = join(uploadDir, fileName);
    return {
      open: async () => {
        await mkdir(uploadDir, { recursive: true });
        await writeFile(uploadPath, new Uint8Array());
        return uploadPath;
      },
      commit: async () => {},
      discard: () => rm(uploadDir, { recursive: true, force: true }),
      respond: (error) => ({
        type: "file.upload.response",
        payload: {
          requestId: request.requestId,
          file: error
            ? null
            : {
                type: "uploaded_file",
                id,
                fileName,
                mimeType: request.mimeType,
                size: request.size,
                path: uploadPath,
              },
          error,
        },
      }),
    };
  }

  async receiveFrame(
    frame: FileTransferFrame,
    source: object = this.defaultSource,
  ): Promise<UploadResponse | null> {
    const upload = this.pending.get(source)?.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    void operation.then(
      (response) => {
        if (response) upload.finished(response);
        return undefined;
      },
      () => upload.finished(null),
    );
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<UploadResponse | null> {
    if (this.pending.get(upload.source)?.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return upload.target.respond(getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    upload.writePath = await upload.target.open();
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.writePath) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.writePath, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<UploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await upload.target.discard();
      return upload.target.respond(
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    if (!upload.writePath) {
      await upload.target.discard();
      return upload.target.respond("Upload ended before file begin.");
    }
    await upload.target.commit();
    upload.completed = true;
    return upload.target.respond(null);
  }

  private createStaleUploadTimeout(
    source: object,
    requestId: string,
  ): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      const upload = this.pending.get(source)?.get(requestId);
      if (upload) void this.cancel(upload).catch(() => {});
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.source, upload.requestId);
  }

  private cancel(upload: PendingUpload): Promise<void> {
    if (upload.cleanup) return upload.cleanup;
    this.clearPendingUpload(upload);
    upload.cleanup = upload.queue.then(async () => {
      if (!upload.completed) await upload.target.discard();
      return undefined;
    });
    upload.finished(null);
    return upload.cleanup;
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    const uploads = this.pending.get(upload.source);
    if (uploads?.get(upload.requestId) === upload) uploads.delete(upload.requestId);
    if (uploads?.size === 0) this.pending.delete(upload.source);
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await upload.target.discard();
  }
}

function createWorkspaceTarget(request: FileEntryUploadRequest): UploadTarget {
  let prepared: { path: string; targetPath: string; temporaryPath: string } | null = null;
  return {
    open: async () => {
      const preparation = await prepareExplorerUpload({
        root: request.cwd,
        parentPath: request.parentPath,
        name: request.name,
      });
      if (preparation.status === "error") throw new Error(preparation.error);
      prepared = preparation;
      return preparation.temporaryPath;
    },
    commit: async () => {
      if (!prepared) throw new Error("Upload ended before file begin.");
      await commitExplorerUpload(prepared);
    },
    discard: async () => {
      if (prepared) await rm(prepared.temporaryPath, { force: true });
    },
    respond: (error) => ({
      type: "fs.entry.upload.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: error ? null : (prepared?.path ?? null),
        success: error === null,
        error,
        requestId: request.requestId,
      },
    }),
  };
}

// Most file systems cap a single file name at 255 bytes.
const MAX_FILE_NAME_BYTES = 255;

// Keeps the client's file name, replacing only what cannot appear in a single
// file name on Linux, macOS, or Windows.
function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return fitFileNameLength(name.length > 0 && name !== "." && name !== ".." ? name : "upload");
}

function fitFileNameLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES) return name;
  const extension = extname(name);
  const keptExtension = Buffer.byteLength(extension) < MAX_FILE_NAME_BYTES ? extension : "";
  let stem = "";
  for (const char of name.slice(0, name.length - keptExtension.length)) {
    if (Buffer.byteLength(stem + char + keptExtension) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + keptExtension;
}
