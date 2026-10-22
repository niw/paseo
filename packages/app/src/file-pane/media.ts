import { getFileExtension } from "@/attachments/file-types";

export type MediaKind = "video" | "audio";

export interface MediaType {
  kind: MediaKind;
  mimeType: string;
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, MediaType> = {
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".m4v": { kind: "video", mimeType: "video/x-m4v" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
  ".m4a": { kind: "audio", mimeType: "audio/mp4" },
  ".aac": { kind: "audio", mimeType: "audio/aac" },
  ".wav": { kind: "audio", mimeType: "audio/wav" },
  ".ogg": { kind: "audio", mimeType: "audio/ogg" },
  ".oga": { kind: "audio", mimeType: "audio/ogg" },
  ".opus": { kind: "audio", mimeType: "audio/opus" },
  ".flac": { kind: "audio", mimeType: "audio/flac" },
};

// NOTE: The player plays a local copy of the whole file, so the read stops at this size.
export const MAX_MEDIA_PREVIEW_BYTES = 100 * 1024 * 1024;

/**
 * The media type a file plays as, from its extension. Daemons classify media as binary
 * and name a MIME type for only a few extensions, so the app owns this mapping.
 */
export function mediaTypeForPath(path: string): MediaType | null {
  return MEDIA_TYPE_BY_EXTENSION[getFileExtension(path)] ?? null;
}
